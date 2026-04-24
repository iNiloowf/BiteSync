"use client";

import { createPortal } from "react-dom";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AuthChangeEvent, Session, User } from "@supabase/supabase-js";

import { categories, countries, type Category } from "@/data/mock-data";
import { getSupabaseBrowserClient, hasSupabaseEnv, supabaseConfigError } from "@/lib/supabase";

const uiPage =
  "bg-[radial-gradient(ellipse_120%_85%_at_50%_-10%,rgba(255,124,88,0.12),transparent_50%),radial-gradient(ellipse_90%_55%_at_100%_100%,rgba(115,82,210,0.1),transparent_46%),#0a090d]";
const uiShell =
  "rounded-[28px] border border-white/10 bg-[#151119]/96 shadow-[0_26px_90px_rgba(0,0,0,0.52)] backdrop-blur-xl";
const uiStickyBar = "border-b border-white/10 bg-[#151119]/95 backdrop-blur-md";
const uiPopover = "rounded-2xl border border-white/10 bg-[#1c1624] shadow-[0_20px_55px_rgba(0,0,0,0.42)]";
const uiToastBar =
  "rounded-2xl border border-white/12 bg-[#1a1520]/95 shadow-[0_14px_40px_rgba(0,0,0,0.38)] backdrop-blur-md";
const uiInset = "bg-[#151119]";
const uiSwipeDeck = "rounded-[28px] bg-[#151119]";

type Screen = "auth" | "home" | "profile" | "room" | "hidden_places";
type AuthMode = "signin" | "signup";
type RoomStage =
  | "lobby"
  | "categories"
  | "waiting_categories"
  | "category_match"
  | "restaurants"
  | "final";

type HiddenPlace = { id: string; name: string };

type Profile = {
  id: string;
  full_name: string;
  country_code: string;
  city: string;
  avatar_url: string | null;
  hidden_restaurants?: HiddenPlace[] | null;
};

function parseHiddenRestaurants(raw: unknown): HiddenPlace[] {
  if (!Array.isArray(raw)) return [];
  const out: HiddenPlace[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const o = row as { id?: unknown; name?: unknown };
    if (typeof o.id !== "string" || !o.id) continue;
    out.push({
      id: o.id,
      name: typeof o.name === "string" && o.name.trim() ? o.name.trim() : o.id,
    });
  }
  return out;
}

function profileFromDbRow(row: Record<string, unknown>): Profile {
  return {
    id: String(row.id),
    full_name: String(row.full_name ?? ""),
    country_code: String(row.country_code ?? "US"),
    city: String(row.city ?? ""),
    avatar_url: row.avatar_url == null || row.avatar_url === "" ? null : String(row.avatar_url),
    hidden_restaurants: parseHiddenRestaurants(row.hidden_restaurants),
  };
}

type RoomSyncFlowStage = "lobby" | "categories" | "restaurants" | "final";

type RoomRecord = {
  id: string;
  code: string;
  host_name: string;
  country_code: string;
  city: string;
  flow_stage?: RoomSyncFlowStage;
};

function isRoomSyncFlowStage(value: string): value is RoomSyncFlowStage {
  return value === "lobby" || value === "categories" || value === "restaurants" || value === "final";
}

function nextRoomStageFromSyncedFlow(current: RoomStage, synced: RoomSyncFlowStage): RoomStage | null {
  if (synced === "categories") {
    if (current === "lobby") return "categories";
    return null;
  }
  if (synced === "restaurants") {
    if (
      current === "lobby" ||
      current === "categories" ||
      current === "waiting_categories" ||
      current === "category_match"
    ) {
      return "restaurants";
    }
    return null;
  }
  if (synced === "final") {
    if (current === "restaurants" || current === "final") return "final";
    return null;
  }
  return null;
}

type RoomMember = {
  id: string;
  name: string;
  joined_at: string;
  user_id: string | null;
};

type CityRestaurant = {
  id: string;
  name: string;
  address: string;
  rating: number | null;
  userRatingCount: number | null;
  priceLevel: string | null;
  primaryType: string | null;
  categoryIds: string[];
  photoUrls?: string[];
};

type RoomCategoryVote = {
  id: string;
  user_id: string | null;
  category_id: string;
  decision: "like" | "skip";
  member_name: string;
};

type RoomRestaurantVote = {
  id: string;
  user_id: string | null;
  restaurant_id: string;
  decision: "like" | "skip";
  member_name: string;
};

type UntypedQueryResult<T> = Promise<{ data: T; error?: { message?: string } | null }>;

type ProfilesTable = {
  select: (query?: string) => {
    eq: (column: string, value: string) => {
      maybeSingle: () => UntypedQueryResult<Profile | null>;
    };
  };
  upsert: (value: unknown) => {
    select: () => {
      single: () => UntypedQueryResult<Profile>;
    };
  };
};

type RoomsTable = {
  select: (query?: string) => {
    eq: (column: string, value: string) => {
      maybeSingle: () => UntypedQueryResult<RoomRecord | null>;
    };
  };
  insert: (value: unknown) => {
    select: () => {
      single: () => UntypedQueryResult<RoomRecord>;
    };
  };
  update: (value: { flow_stage: RoomSyncFlowStage }) => {
    eq: (column: string, value: string) => Promise<{ error?: { message?: string } | null }>;
  };
};

type MembersTable = {
  insert: (value: unknown) => Promise<{ error?: { message?: string } | null }>;
};

type CategoryVotesTable = {
  insert: (value: unknown) => Promise<{ error?: { message?: string } | null }>;
};

type RestaurantVotesTable = {
  insert: (value: unknown) => Promise<{ error?: { message?: string } | null }>;
};

type RestaurantPassCompleteTable = {
  upsert: (
    value: { room_id: string; participant_key: string },
    options?: { onConflict?: string },
  ) => Promise<{ error?: { message?: string } | null }>;
  delete: () => {
    eq: (column: string, value: string) => Promise<{ error?: { message?: string } | null }>;
  };
};

type ErrorLike = {
  message?: string;
  code?: string;
};

function normalizedMemberNameKey(name: string): string {
  return `n:${name.trim().toLowerCase()}`;
}

/** Stable key for restaurant-pass completion; must match between room roster and who upserts to DB. */
function restaurantPassParticipantKey(member: RoomMember): string {
  if (member.user_id) return `u:${String(member.user_id).trim()}`;
  return normalizedMemberNameKey(member.name);
}

function restaurantPassParticipantKeyForSelf(userId: string | null | undefined, displayName: string | undefined): string | null {
  if (userId) return `u:${String(userId).trim()}`;
  const n = displayName?.trim();
  if (!n) return null;
  return normalizedMemberNameKey(n);
}

function restaurantVoteVoterKey(vote: RoomRestaurantVote): string {
  if (vote.user_id) return `u:${String(vote.user_id).trim()}`;
  if (vote.member_name?.trim()) return normalizedMemberNameKey(vote.member_name);
  return "";
}

function displayNameForRestaurantVoterKey(key: string, members: readonly RoomMember[]): string {
  if (key.startsWith("u:")) {
    const uid = key.slice(2).trim();
    const hit = members.find((m) => m.user_id && String(m.user_id).trim() === uid);
    return hit?.name?.trim() || "Someone";
  }
  const hit = members.find((m) => normalizedMemberNameKey(m.name) === key);
  return hit?.name?.trim() || "Someone";
}

function categoryVoteKey(vote: RoomCategoryVote): string {
  if (vote.user_id) return String(vote.user_id).trim();
  if (vote.member_name) return normalizedMemberNameKey(vote.member_name);
  return "";
}

function categoryVoteMergeKey(vote: RoomCategoryVote): string {
  return `${categoryVoteKey(vote)}::${vote.category_id}`;
}

function mergeCategoryVotesFromServer(serverRows: RoomCategoryVote[], previous: RoomCategoryVote[]): RoomCategoryVote[] {
  const merged = [...serverRows];
  const seen = new Set(serverRows.map(categoryVoteMergeKey));
  for (const vote of previous) {
    if (typeof vote.id !== "string" || !vote.id.startsWith("local-cat-")) continue;
    const key = categoryVoteMergeKey(vote);
    if (seen.has(key)) continue;
    merged.push(vote);
    seen.add(key);
  }
  return merged;
}

function restaurantVoteMergeKey(vote: RoomRestaurantVote): string {
  const userKey = vote.user_id ? vote.user_id : vote.member_name ? `n:${vote.member_name}` : "";
  return `${userKey}::${vote.restaurant_id}`;
}

function mergeRestaurantVotesFromServer(
  serverRows: RoomRestaurantVote[],
  previous: RoomRestaurantVote[],
): RoomRestaurantVote[] {
  const merged = [...serverRows];
  const seen = new Set(serverRows.map(restaurantVoteMergeKey));
  for (const vote of previous) {
    if (typeof vote.id !== "string" || !vote.id.startsWith("local-rest-")) continue;
    const key = restaurantVoteMergeKey(vote);
    if (seen.has(key)) continue;
    merged.push(vote);
    seen.add(key);
  }
  return merged;
}

function roomMemberKey(member: RoomMember): string {
  if (member.user_id) return String(member.user_id).trim();
  return normalizedMemberNameKey(member.name);
}

/** Same Set may appear under user_id and n:name so progress survives key mismatches across rows vs votes. */
function buildMemberCategoryProgress(votes: readonly RoomCategoryVote[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const vote of votes) {
    const primary = categoryVoteKey(vote);
    if (!primary) continue;
    let set = map.get(primary);
    if (!set) {
      set = new Set<string>();
      map.set(primary, set);
    }
    set.add(vote.category_id);
    if (vote.user_id && vote.member_name?.trim()) {
      const alt = normalizedMemberNameKey(vote.member_name);
      if (alt !== primary) {
        map.set(alt, set);
      }
    }
  }
  return map;
}

function memberCategoryVotesSet(
  member: RoomMember,
  progress: ReadonlyMap<string, Set<string>>,
): Set<string> | undefined {
  if (member.user_id) {
    const byId = progress.get(String(member.user_id).trim());
    if (byId && byId.size > 0) return byId;
  }
  return progress.get(normalizedMemberNameKey(member.name));
}

type SupabaseBrowser = NonNullable<ReturnType<typeof getSupabaseBrowserClient>>;

function mergeMemberRowsFromServer(serverRows: RoomMember[], previous: RoomMember[]): RoomMember[] {
  const byKey = new Map<string, RoomMember>();
  for (const row of serverRows) {
    byKey.set(roomMemberKey(row), row);
  }

  for (const member of previous) {
    if (!member.id.startsWith("bc-") && !member.id.startsWith("local-")) continue;
    const key = roomMemberKey(member);
    if (byKey.has(key)) continue;
    if (member.user_id && [...byKey.values()].some((row) => row.user_id === member.user_id)) continue;
    if (
      !member.user_id &&
      [...byKey.values()].some(
        (row) => row.name.trim().toLowerCase() === member.name.trim().toLowerCase(),
      )
    ) {
      continue;
    }
    byKey.set(key, member);
  }

  return [...byKey.values()].sort(
    (left, right) => new Date(left.joined_at).getTime() - new Date(right.joined_at).getTime(),
  );
}

function broadcastRoomMemberJoined(client: SupabaseBrowser, roomId: string, name: string, userId: string) {
  const channel = client.channel(`room-handshake-${roomId}`);
  const teardown = () => {
    window.clearTimeout(failSafe);
    void client.removeChannel(channel);
  };
  const failSafe = window.setTimeout(teardown, 8000);
  channel.subscribe((status) => {
    if (status === "SUBSCRIBED") {
      window.clearTimeout(failSafe);
      void channel.send({
        type: "broadcast",
        event: "member_joined",
        payload: { name: name.trim(), user_id: userId },
      });
      window.setTimeout(teardown, 1500);
    }
  });
}

type RoomFlowBroadcastEvent = "categories_started" | "restaurants_started" | "final_results_started";

function broadcastRoomFlowEvent(
  client: SupabaseBrowser,
  roomId: string,
  event: RoomFlowBroadcastEvent,
  payload: Record<string, unknown> = {},
) {
  const channel = client.channel(`room-handshake-${roomId}`);
  const teardown = () => {
    window.clearTimeout(failSafe);
    void client.removeChannel(channel);
  };
  const failSafe = window.setTimeout(teardown, 8000);
  channel.subscribe((status) => {
    if (status === "SUBSCRIBED") {
      window.clearTimeout(failSafe);
      void channel.send({
        type: "broadcast",
        event,
        payload,
      });
      window.setTimeout(teardown, 1500);
    }
  });
}

type PersistRoomFlowResult = { ok: true } | { ok: false; reason: string };

async function persistRoomFlowStage(
  client: SupabaseBrowser,
  roomId: string,
  stage: RoomSyncFlowStage,
): Promise<PersistRoomFlowResult> {
  const roomsUpdate = client.from("rooms") as unknown as {
    update: (row: { flow_stage: RoomSyncFlowStage }) => {
      eq: (column: string, value: string) => Promise<{ error: { message?: string } | null }>;
    };
  };
  const { error: updateError } = await roomsUpdate.update({ flow_stage: stage }).eq("id", roomId);
  if (!updateError) return { ok: true };

  const rpcResult = await (
    client as unknown as {
      rpc: (
        name: string,
        args: { p_room_id: string; p_flow_stage: RoomSyncFlowStage },
      ) => Promise<{ error: { message?: string } | null }>;
    }
  ).rpc("set_room_flow_stage", { p_room_id: roomId, p_flow_stage: stage });
  if (!rpcResult.error) return { ok: true };

  const reason = [updateError?.message, rpcResult.error?.message]
    .filter((m): m is string => Boolean(m && m.trim()))
    .join(" · ");
  return { ok: false, reason: reason || "Database rejected the update." };
}

function formatRoomFlowPersistUserMessage(reason: string) {
  const head = `Sync failed: ${reason}`;
  if (
    /rooms_flow_stage_check|violates check constraint.*rooms|invalid flow_stage|new row for relation "rooms"/i.test(
      reason,
    )
  ) {
    return `${head}. Run supabase/migrations/20260424220000_room_flow_stage_final.sql in Supabase SQL, then reload the API schema cache. (Live broadcast may still work for people in the room.)`;
  }
  if (/flow_stage|schema cache|column .* does not exist|does not exist.*flow_stage/i.test(reason)) {
    return `${head}. Add rooms.flow_stage (see 20260423140000_ensure_rooms_flow_stage_column.sql), then reload schema cache.`;
  }
  return `${head}. Check migrations 20260422143000_set_room_flow_stage_rpc.sql and 20260423120000_room_flow_host_name_allowed.sql for RPC and policies.`;
}

export function FoodMatchApp() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);

  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const profileRef = useRef(profile);
  profileRef.current = profile;
  const [screen, setScreen] = useState<Screen>(hasSupabaseEnv ? "auth" : "home");
  const [authMode, setAuthMode] = useState<AuthMode>("signup");
  const [loading, setLoading] = useState(hasSupabaseEnv);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeRoom, setActiveRoom] = useState<RoomRecord | null>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [countryCode, setCountryCode] = useState("US");
  const [city, setCity] = useState("Denver");
  const [roomCodeInput, setRoomCodeInput] = useState("");
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [roomMembers, setRoomMembers] = useState<RoomMember[]>([]);
  const [cityRestaurants, setCityRestaurants] = useState<CityRestaurant[]>([]);
  const [restaurantsLoading, setRestaurantsLoading] = useState(false);
  const [placesFetchNonce, setPlacesFetchNonce] = useState(0);
  const [roomStage, setRoomStage] = useState<RoomStage>("lobby");
  const [categoryVotes, setCategoryVotes] = useState<RoomCategoryVote[]>([]);
  const [restaurantVotes, setRestaurantVotes] = useState<RoomRestaurantVote[]>([]);
  const [restaurantRoundMemberKeys, setRestaurantRoundMemberKeys] = useState<string[]>([]);
  const [restaurantFinishedMemberKeys, setRestaurantFinishedMemberKeys] = useState<string[]>([]);
  const [swipePickLabel, setSwipePickLabel] = useState("");
  const [undoHidePlace, setUndoHidePlace] = useState<CityRestaurant | null>(null);
  const undoHidePlaceRef = useRef<CityRestaurant | null>(null);
  const undoHideTimerRef = useRef<number | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const getProfilesTable = useCallback(
    () => supabase?.from("profiles") as unknown as ProfilesTable,
    [supabase],
  );

  const getRoomsTable = useCallback(
    () => supabase?.from("rooms") as unknown as RoomsTable,
    [supabase],
  );

  const getMembersTable = useCallback(
    () => supabase?.from("room_members") as unknown as MembersTable,
    [supabase],
  );

  const getCategoryVotesTable = useCallback(
    () => supabase?.from("room_category_votes") as unknown as CategoryVotesTable,
    [supabase],
  );

  const getRestaurantVotesTable = useCallback(
    () => supabase?.from("room_restaurant_votes") as unknown as RestaurantVotesTable,
    [supabase],
  );

  const getRestaurantPassCompleteTable = useCallback(
    () => supabase?.from("room_restaurant_pass_complete") as unknown as RestaurantPassCompleteTable,
    [supabase],
  );

  const insertRoomMember = useCallback(
    async (roomId: string, name: string, userId: string) => {
      const membersTable = getMembersTable();

      const { error } = await membersTable.insert({
        room_id: roomId,
        user_id: userId,
        name,
      });

      if (!error) {
        return null;
      }

      if (!isMissingColumnError(error, "user_id")) {
        return error;
      }

      const { error: fallbackError } = await membersTable.insert({
        room_id: roomId,
        name,
      });

      return fallbackError ?? null;
    },
    [getMembersTable],
  );

  const insertCategoryVote = useCallback(
    async (row: {
      room_id: string;
      user_id: string;
      member_name: string;
      category_id: string;
      decision: "like" | "skip";
    }) => {
      const table = getCategoryVotesTable();
      const { error } = await table.insert(row);

      if (!error) {
        return null;
      }

      if (!isMissingColumnError(error, "user_id")) {
        return error;
      }

      const { error: fallbackError } = await table.insert({
        room_id: row.room_id,
        member_name: row.member_name,
        category_id: row.category_id,
        decision: row.decision,
      });

      return fallbackError ?? null;
    },
    [getCategoryVotesTable],
  );

  const insertRestaurantVote = useCallback(
    async (row: {
      room_id: string;
      user_id: string;
      member_name: string;
      restaurant_id: string;
      decision: "like" | "skip";
    }) => {
      const table = getRestaurantVotesTable();
      const { error } = await table.insert(row);

      if (!error) {
        return null;
      }

      if (!isMissingColumnError(error, "user_id")) {
        return error;
      }

      const { error: fallbackError } = await table.insert({
        room_id: row.room_id,
        member_name: row.member_name,
        restaurant_id: row.restaurant_id,
        decision: row.decision,
      });

      return fallbackError ?? null;
    },
    [getRestaurantVotesTable],
  );

  const syncRoomMembers = useCallback((memberName: string) => {
    setRoomMembers((current) => {
      if (current.some((member) => member.name === memberName)) {
        return current;
      }

      return [
        ...current,
        {
          id: `local-${memberName}`,
          name: memberName,
          joined_at: new Date().toISOString(),
          user_id: null,
        },
      ];
    });
  }, []);

  const visibleRoomMembers = activeRoom ? roomMembers : [];
  const distinctRoomMembers = useMemo(() => {
    if (!activeRoom) return [] as RoomMember[];
    const byKey = new Map<string, RoomMember>();
    for (const member of roomMembers) {
      const k = roomMemberKey(member);
      if (!byKey.has(k)) byKey.set(k, member);
    }
    return [...byKey.values()].sort(
      (a, b) => new Date(a.joined_at).getTime() - new Date(b.joined_at).getTime(),
    );
  }, [activeRoom, roomMembers]);
  const distinctRoomMembersRef = useRef(distinctRoomMembers);
  distinctRoomMembersRef.current = distinctRoomMembers;
  const visibleCityRestaurants = useMemo(
    () => (activeRoom ? cityRestaurants : []),
    [activeRoom, cityRestaurants],
  );
  const currentUserId = session?.user.id ?? null;

  const isRoomHost = useMemo(() => {
    if (!activeRoom?.host_name || !profile?.full_name) return false;
    return profile.full_name.trim().toLowerCase() === activeRoom.host_name.trim().toLowerCase();
  }, [activeRoom?.host_name, profile?.full_name]);

  const memberCount = useMemo(() => {
    if (distinctRoomMembers.length === 0) return 1;
    const distinctUserIds = new Set(
      distinctRoomMembers.map((m) => m.user_id).filter((id): id is string => Boolean(id)),
    );
    if (distinctUserIds.size >= 2) return distinctUserIds.size;
    const distinctNames = new Set(distinctRoomMembers.map((m) => m.name.trim().toLowerCase()));
    return Math.max(distinctNames.size, 1);
  }, [distinctRoomMembers]);

  /** Same keys as restaurant votes / pass-complete; avoids inflated memberCount when roster is incomplete. */
  const restaurantConsensusMemberCount = useMemo(() => {
    const keys = new Set(distinctRoomMembers.map((m) => restaurantPassParticipantKey(m)));
    const n = keys.size;
    if (n >= 2) return n;
    return memberCount;
  }, [distinctRoomMembers, memberCount]);

  const myCategoryVotes = useMemo(
    () =>
      categoryVotes.filter(
        (vote) =>
          (currentUserId && vote.user_id === currentUserId) ||
          (vote.user_id == null && profile && vote.member_name === profile.full_name),
      ),
    [categoryVotes, currentUserId, profile],
  );

  const pendingCategories = useMemo(
    () => categories.filter((category) => !myCategoryVotes.some((vote) => vote.category_id === category.id)),
    [myCategoryVotes],
  );

  const sharedCategoryIds = useMemo(
    () => getSharedLikedIds({
      votes: categoryVotes,
      itemKey: "category_id",
      memberCount,
      fallbackVotes: myCategoryVotes,
    }),
    [categoryVotes, memberCount, myCategoryVotes],
  );

  const sharedMatchCategories = useMemo(
    () =>
      sharedCategoryIds
        .map((id) => categories.find((c) => c.id === id))
        .filter((c): c is Category => Boolean(c)),
    [sharedCategoryIds],
  );

  const categoryDeckSize = categories.length;

  const memberCategoryProgress = useMemo(() => buildMemberCategoryProgress(categoryVotes), [categoryVotes]);

  const allMembersFinishedCategories = useMemo(() => {
    if (memberCount <= 1) return true;
    if (distinctRoomMembers.length === 0) return false;
    for (const member of distinctRoomMembers) {
      const set = memberCategoryVotesSet(member, memberCategoryProgress);
      if (!set || set.size < categoryDeckSize) return false;
    }
    return true;
  }, [memberCount, distinctRoomMembers, memberCategoryProgress, categoryDeckSize]);

  const membersStillSwipingCategories = useMemo(() => {
    if (memberCount <= 1) return [] as RoomMember[];
    return distinctRoomMembers.filter((member) => {
      const set = memberCategoryVotesSet(member, memberCategoryProgress);
      return !set || set.size < categoryDeckSize;
    });
  }, [memberCount, distinctRoomMembers, memberCategoryProgress, categoryDeckSize]);

  const soloLikedCategoryIds = useMemo(
    () => myCategoryVotes.filter((vote) => vote.decision === "like").map((vote) => vote.category_id),
    [myCategoryVotes],
  );

  const unionLikedCategoryIds = useMemo(() => {
    const ids = new Set<string>();
    for (const vote of categoryVotes) {
      if (vote.decision === "like") ids.add(vote.category_id);
    }
    return [...ids];
  }, [categoryVotes]);

  const restaurantFocusCategoryIds = useMemo(() => {
    if (sharedCategoryIds.length > 0) return sharedCategoryIds;
    if (memberCount <= 1) return soloLikedCategoryIds;
    return unionLikedCategoryIds;
  }, [sharedCategoryIds, memberCount, soloLikedCategoryIds, unionLikedCategoryIds]);

  const restaurantFocusCategories = useMemo(
    () =>
      restaurantFocusCategoryIds
        .map((id) => categories.find((c) => c.id === id))
        .filter((c): c is Category => Boolean(c)),
    [restaurantFocusCategoryIds],
  );

  const diningPlacesFetchKey = useMemo(() => {
    if (!activeRoom) return "";
    const wantsPlaces =
      roomStage === "restaurants" || roomStage === "final" || roomStage === "category_match";
    if (!wantsPlaces) {
      return `${activeRoom.id}-preload`;
    }

    const focusIds =
      restaurantFocusCategoryIds.length > 0
        ? restaurantFocusCategoryIds
        : memberCount <= 1
          ? soloLikedCategoryIds
          : [];

    return `${activeRoom.id}-dining-${focusIds.join("|") || "all"}-${placesFetchNonce}`;
  }, [activeRoom, roomStage, restaurantFocusCategoryIds, soloLikedCategoryIds, memberCount, placesFetchNonce]);

  const hiddenRestaurantIdSet = useMemo(
    () => new Set((profile?.hidden_restaurants ?? []).map((h) => h.id)),
    [profile?.hidden_restaurants],
  );

  const restaurantCandidates = useMemo(() => {
    const sortByRating = (left: CityRestaurant, right: CityRestaurant) => {
      const leftPriority = left.rating !== null && left.rating >= 4 ? 1 : 0;
      const rightPriority = right.rating !== null && right.rating >= 4 ? 1 : 0;

      if (rightPriority !== leftPriority) {
        return rightPriority - leftPriority;
      }

      return (right.rating ?? 0) - (left.rating ?? 0);
    };

    const focusIds = restaurantFocusCategoryIds;
    const notHidden = (r: CityRestaurant) => !hiddenRestaurantIdSet.has(r.id);

    const primary = visibleCityRestaurants
      .filter((restaurant) =>
        focusIds.length === 0
          ? memberCount <= 1 &&
            restaurant.categoryIds.some((categoryId) => soloLikedCategoryIds.includes(categoryId))
          : restaurant.categoryIds.some((categoryId) => focusIds.includes(categoryId)),
      )
      .filter(notHidden)
      .sort(sortByRating);

    if (primary.length > 0) return primary;
    if (visibleCityRestaurants.length > 0) {
      return [...visibleCityRestaurants].filter(notHidden).sort(sortByRating);
    }
    return primary;
  }, [
    memberCount,
    restaurantFocusCategoryIds,
    soloLikedCategoryIds,
    visibleCityRestaurants,
    hiddenRestaurantIdSet,
  ]);

  const myRestaurantVotes = useMemo(
    () =>
      restaurantVotes.filter(
        (vote) =>
          (currentUserId && vote.user_id === currentUserId) ||
          (vote.user_id == null && profile && vote.member_name === profile.full_name),
      ),
    [currentUserId, profile, restaurantVotes],
  );

  const pendingRestaurants = useMemo(
    () =>
      restaurantCandidates.filter(
        (restaurant) => !myRestaurantVotes.some((vote) => vote.restaurant_id === restaurant.id),
      ),
    [myRestaurantVotes, restaurantCandidates],
  );

  const restaurantRoundExpectedMemberKeys = useMemo(() => {
    if (restaurantRoundMemberKeys.length > 0) return restaurantRoundMemberKeys;
    return [...new Set(distinctRoomMembers.map((member) => restaurantPassParticipantKey(member)))];
  }, [restaurantRoundMemberKeys, distinctRoomMembers]);

  const restaurantMembersByPassKey = useMemo(() => {
    const byKey = new Map<string, RoomMember>();
    for (const member of distinctRoomMembers) {
      const key = restaurantPassParticipantKey(member);
      if (!byKey.has(key)) byKey.set(key, member);
    }
    return byKey;
  }, [distinctRoomMembers]);

  const restaurantFinishedSet = useMemo(
    () => new Set(restaurantFinishedMemberKeys),
    [restaurantFinishedMemberKeys],
  );

  const allMembersFinishedRestaurants = useMemo(() => {
    if (pendingRestaurants.length > 0) return false;
    if (restaurantRoundExpectedMemberKeys.length === 0) return memberCount <= 1;
    return restaurantRoundExpectedMemberKeys.every((key) => restaurantFinishedSet.has(key));
  }, [pendingRestaurants.length, memberCount, restaurantRoundExpectedMemberKeys, restaurantFinishedSet]);

  const membersStillSwipingRestaurants = useMemo(() => {
    if (restaurantRoundExpectedMemberKeys.length === 0) return [] as RoomMember[];
    return restaurantRoundExpectedMemberKeys
      .filter((key) => !restaurantFinishedSet.has(key))
      .map((key) => restaurantMembersByPassKey.get(key))
      .filter((member): member is RoomMember => Boolean(member));
  }, [restaurantRoundExpectedMemberKeys, restaurantMembersByPassKey, restaurantFinishedSet]);

  const strictMutualRestaurantIds = useMemo(() => {
    if (restaurantConsensusMemberCount <= 1) return [] as string[];
    return getSharedLikedIds({
      votes: restaurantVotes,
      itemKey: "restaurant_id",
      memberCount: restaurantConsensusMemberCount,
      fallbackVotes: myRestaurantVotes,
    });
  }, [restaurantConsensusMemberCount, myRestaurantVotes, restaurantVotes]);

  const finalRestaurantIds = useMemo(() => {
    if (restaurantConsensusMemberCount <= 1) {
      return getSharedLikedIds({
        votes: restaurantVotes,
        itemKey: "restaurant_id",
        memberCount: restaurantConsensusMemberCount,
        fallbackVotes: myRestaurantVotes,
      });
    }
    if (strictMutualRestaurantIds.length > 0) {
      return strictMutualRestaurantIds;
    }
    const union = new Set<string>();
    for (const v of restaurantVotes) {
      if (v.decision === "like") union.add(v.restaurant_id);
    }
    return [...union];
  }, [restaurantConsensusMemberCount, myRestaurantVotes, restaurantVotes, strictMutualRestaurantIds]);

  const restaurantDisplayPool = useMemo(() => {
    const byId = new Map<string, CityRestaurant>();
    for (const r of restaurantCandidates) {
      byId.set(r.id, r);
    }
    for (const r of visibleCityRestaurants) {
      if (!byId.has(r.id)) {
        byId.set(r.id, r);
      }
    }
    return [...byId.values()];
  }, [restaurantCandidates, visibleCityRestaurants]);

  const restaurantByIdLookup = useMemo(() => {
    const byId = new Map<string, CityRestaurant>();
    for (const r of restaurantDisplayPool) {
      byId.set(r.id, r);
    }
    return byId;
  }, [restaurantDisplayPool]);

  const restaurantLikeBreakdown = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const v of restaurantVotes) {
      if (v.decision !== "like") continue;
      const k = restaurantVoteVoterKey(v);
      if (!k) continue;
      if (!map.has(v.restaurant_id)) map.set(v.restaurant_id, new Set());
      map.get(v.restaurant_id)!.add(k);
    }
    return map;
  }, [restaurantVotes]);

  const mutualFinalRestaurants = useMemo(() => {
    if (restaurantConsensusMemberCount <= 1) {
      return finalRestaurantIds
        .map((id) => restaurantByIdLookup.get(id))
        .filter((r): r is CityRestaurant => Boolean(r))
        .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
    }
    return strictMutualRestaurantIds
      .map((id) => restaurantByIdLookup.get(id))
      .filter((r): r is CityRestaurant => Boolean(r))
      .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  }, [restaurantConsensusMemberCount, finalRestaurantIds, strictMutualRestaurantIds, restaurantByIdLookup]);

  const partialCoLikedFinalRows = useMemo(() => {
    if (restaurantConsensusMemberCount <= 1) return [] as { restaurant: CityRestaurant; likedByLabel: string }[];
    const rows: { restaurant: CityRestaurant; likedByLabel: string }[] = [];
    const mutualIds = new Set(strictMutualRestaurantIds);
    for (const [id, likers] of restaurantLikeBreakdown) {
      if (mutualIds.has(id)) continue;
      const c = likers.size;
      if (c < 2 || c >= restaurantConsensusMemberCount) continue;
      const r = restaurantByIdLookup.get(id);
      if (!r) continue;
      const names = [...likers].map((key) => displayNameForRestaurantVoterKey(key, distinctRoomMembers));
      names.sort((a, b) => a.localeCompare(b));
      rows.push({ restaurant: r, likedByLabel: names.join(" + ") });
    }
    rows.sort((a, b) => (b.restaurant.rating ?? 0) - (a.restaurant.rating ?? 0));
    return rows;
  }, [
    restaurantConsensusMemberCount,
    strictMutualRestaurantIds,
    restaurantLikeBreakdown,
    restaurantByIdLookup,
    distinctRoomMembers,
  ]);

  const soloLikedFinalRows = useMemo(() => {
    if (restaurantConsensusMemberCount <= 1) return [] as { restaurant: CityRestaurant; likedByLabel: string }[];
    const rows: { restaurant: CityRestaurant; likedByLabel: string }[] = [];
    const mutualIds = new Set(strictMutualRestaurantIds);
    for (const [id, likers] of restaurantLikeBreakdown) {
      if (mutualIds.has(id)) continue;
      if (likers.size !== 1) continue;
      const r = restaurantByIdLookup.get(id);
      if (!r) continue;
      const key = [...likers][0]!;
      rows.push({
        restaurant: r,
        likedByLabel: displayNameForRestaurantVoterKey(key, distinctRoomMembers),
      });
    }
    rows.sort((a, b) => (b.restaurant.rating ?? 0) - (a.restaurant.rating ?? 0));
    return rows;
  }, [
    restaurantConsensusMemberCount,
    strictMutualRestaurantIds,
    restaurantLikeBreakdown,
    restaurantByIdLookup,
    distinctRoomMembers,
  ]);

  const handleHostShowFinalResults = useCallback(() => {
    if (!isRoomHost) return;
    setRoomStage("final");
    const roomId = activeRoom?.id;
    if (supabase && roomId) {
      broadcastRoomFlowEvent(supabase, roomId, "final_results_started");
      void persistRoomFlowStage(supabase, roomId, "final").then((r) => {
        if (!r.ok) setMessage(formatRoomFlowPersistUserMessage(r.reason));
      });
    }
  }, [isRoomHost, supabase, activeRoom?.id]);

  const handleHostRestartCategories = useCallback(async () => {
    if (!supabase || !activeRoom || !isRoomHost) return;
    try {
      const roomId = activeRoom.id;
      setCategoryVotes([]);
      setRestaurantVotes([]);
      setRestaurantRoundMemberKeys([]);
      setRestaurantFinishedMemberKeys([]);
      setSwipePickLabel("");
      setRoomStage("categories");

      const { error: categoryDeleteError } = await supabase.from("room_category_votes").delete().eq("room_id", roomId);
      if (categoryDeleteError) throw categoryDeleteError;

      const { error: restaurantDeleteError } = await supabase
        .from("room_restaurant_votes")
        .delete()
        .eq("room_id", roomId);
      if (restaurantDeleteError) throw restaurantDeleteError;

      const passComplete = getRestaurantPassCompleteTable();
      if (passComplete) {
        await passComplete.delete().eq("room_id", roomId);
      }

      const persistResult = await persistRoomFlowStage(supabase, roomId, "categories");
      if (!persistResult.ok) {
        setMessage(formatRoomFlowPersistUserMessage(persistResult.reason));
      }
      broadcastRoomFlowEvent(supabase, roomId, "categories_started");
    } catch (error) {
      setMessage(getErrorMessage(error, "Could not restart category round."));
    }
  }, [supabase, activeRoom, isRoomHost, getRestaurantPassCompleteTable]);

  const handleHostRestartRestaurants = useCallback(async () => {
    if (!supabase || !activeRoom || !isRoomHost) return;
    try {
      const roomId = activeRoom.id;
      const memberKeys = [...new Set(distinctRoomMembers.map((member) => restaurantPassParticipantKey(member)))];
      setRestaurantVotes([]);
      setRestaurantRoundMemberKeys(memberKeys);
      setRestaurantFinishedMemberKeys([]);
      setSwipePickLabel("");
      setRoomStage("restaurants");

      const { error: restaurantDeleteError } = await supabase
        .from("room_restaurant_votes")
        .delete()
        .eq("room_id", roomId);
      if (restaurantDeleteError) throw restaurantDeleteError;

      const passComplete = getRestaurantPassCompleteTable();
      if (passComplete) {
        await passComplete.delete().eq("room_id", roomId);
      }

      const persistResult = await persistRoomFlowStage(supabase, roomId, "restaurants");
      if (!persistResult.ok) {
        setMessage(formatRoomFlowPersistUserMessage(persistResult.reason));
      }
      broadcastRoomFlowEvent(supabase, roomId, "restaurants_started", { member_keys: memberKeys });
    } catch (error) {
      setMessage(getErrorMessage(error, "Could not restart restaurant round."));
    }
  }, [supabase, activeRoom, isRoomHost, getRestaurantPassCompleteTable, distinctRoomMembers]);

  const loadProfile = useCallback(
    async (user: User) => {
      if (!supabase) return;

      setEmail(user.email ?? "");

      const profilesQuery = getProfilesTable();

      const { data } = await profilesQuery.select("*").eq("id", user.id).maybeSingle();

      if (data) {
        const normalized = profileFromDbRow(data as unknown as Record<string, unknown>);
        setProfile(normalized);
        setFullName(normalized.full_name);
        setCountryCode(normalized.country_code || "US");
        setCity(normalized.city || "Denver");
        return;
      }

      const fallbackProfile: Profile = {
        id: user.id,
        full_name: user.user_metadata.full_name ?? user.email?.split("@")[0] ?? "BiteSync User",
        country_code: user.user_metadata.country_code ?? "US",
        city: user.user_metadata.city ?? "Denver",
        avatar_url: null,
        hidden_restaurants: [],
      };

      const { data: inserted } = await profilesQuery.upsert(fallbackProfile).select().single();

      const insertedProfile = inserted
        ? profileFromDbRow(inserted as unknown as Record<string, unknown>)
        : fallbackProfile;
      setProfile(insertedProfile);
      setFullName(insertedProfile.full_name);
      setCountryCode(insertedProfile.country_code);
      setCity(insertedProfile.city);
    },
    [getProfilesTable, supabase],
  );

  useEffect(() => {
    if (!supabase) return;

    let mounted = true;

    supabase.auth.getSession().then(async ({ data }) => {
      if (!mounted) return;
      const nextSession = data.session;
      setSession(nextSession);
      setEmail(nextSession?.user.email ?? "");
      if (nextSession?.user) {
        await loadProfile(nextSession.user);
        setScreen((current) => (current === "auth" ? "home" : current));
      } else {
        setScreen("auth");
      }
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event: AuthChangeEvent, nextSession) => {
      setSession(nextSession);
      setEmail(nextSession?.user.email ?? "");
      if (nextSession?.user) {
        void loadProfile(nextSession.user);
        if (event === "INITIAL_SESSION" || event === "SIGNED_IN") {
          setScreen((current) => (current === "auth" ? "home" : current));
        }
      } else {
        setProfile(null);
        setScreen("auth");
      }
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [loadProfile, supabase]);

  useEffect(() => {
    if (!supabase) return;
    const token = session?.access_token;
    void supabase.realtime.setAuth(token ?? null);
  }, [supabase, session?.access_token]);

  useEffect(() => {
    function handleOutsideClick(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }

    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, []);

  async function handleAuthSubmit() {
    if (!supabase) return;
    setSubmitting(true);
    setMessage("");

    try {
      if (authMode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: {
              full_name: fullName,
              country_code: countryCode,
              city,
            },
          },
        });

        if (error) throw error;

        if (data.user) {
          await getProfilesTable().upsert({
            id: data.user.id,
            full_name: fullName,
            country_code: countryCode,
            city,
            avatar_url: null,
            hidden_restaurants: [],
          });
          setMessage("Your account was created. You can start using BiteSync now.");
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) throw error;
      }
    } catch (error) {
      setMessage(getErrorMessage(error, "Something went wrong."));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSignOut() {
    if (!supabase) return;
    await supabase.auth.signOut();
    setMenuOpen(false);
    setActiveRoom(null);
    setRoomStage("lobby");
    setCategoryVotes([]);
    setRestaurantVotes([]);
    setRestaurantRoundMemberKeys([]);
    setRestaurantFinishedMemberKeys([]);
  }

  async function handleSaveProfile() {
    if (!supabase || !session?.user) return;
    setSubmitting(true);
    setMessage("");

    try {
      const normalizedEmail = email.trim();

      if (normalizedEmail && normalizedEmail !== session.user.email) {
        const { error: emailError } = await supabase.auth.updateUser({
          email: normalizedEmail,
        });

        if (emailError) throw emailError;
      }

      const payload = {
        id: session.user.id,
        full_name: fullName,
        country_code: countryCode,
        city,
        avatar_url: profile?.avatar_url ?? null,
        hidden_restaurants: profile?.hidden_restaurants ?? [],
      };

      const { data, error } = await getProfilesTable().upsert(payload).select().single();
      if (error) throw error;

      setProfile(profileFromDbRow(data as unknown as Record<string, unknown>));
      if (normalizedEmail && normalizedEmail !== session.user.email) {
        setMessage("Email update requested. Check your inbox to confirm the new address.");
      }
      setScreen("home");
    } catch (error) {
      setMessage(getErrorMessage(error, "Could not save your profile."));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAvatarUpload(file: File) {
    if (!supabase || !session?.user) return;
    setAvatarUploading(true);
    setMessage("");

    try {
      const ext = file.name.split(".").pop() || "jpg";
      const path = `${session.user.id}/avatar.${ext}`;

      const { error: uploadError } = await supabase.storage
        .from("avatars")
        .upload(path, file, { upsert: true });

      if (uploadError) throw uploadError;

      const { data } = supabase.storage.from("avatars").getPublicUrl(path);

      const { data: updated, error: profileError } = await getProfilesTable()
        .upsert({
          id: session.user.id,
          full_name: fullName,
          country_code: countryCode,
          city,
          avatar_url: data.publicUrl,
          hidden_restaurants: profile?.hidden_restaurants ?? [],
        })
        .select()
        .single();

      if (profileError) throw profileError;
      setProfile(profileFromDbRow(updated as unknown as Record<string, unknown>));
    } catch (error) {
      setMessage(getErrorMessage(error, "Avatar upload failed."));
    } finally {
      setAvatarUploading(false);
    }
  }

  async function handleHostRoom() {
    if (!supabase || !profile || !session?.user) return;
    setSubmitting(true);
    setMessage("");

    try {
      let roomData: RoomRecord | null = null;

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const code = createRoomCode(profile.city);
        const { data, error: roomError } = await getRoomsTable()
          .insert({
            code,
            host_name: profile.full_name,
            country_code: profile.country_code,
            city: profile.city,
          })
          .select()
          .single();

        if (!roomError) {
          roomData = data as RoomRecord;
          break;
        }

        if (!isDuplicateKeyError(roomError)) {
          throw roomError;
        }
      }

      if (!roomData) {
        throw new Error("Could not generate a free room code. Please try again.");
      }

      const memberError = await insertRoomMember(roomData.id, profile.full_name, session.user.id);

      if (memberError) throw memberError;

      setRoomStage("lobby");
      setCategoryVotes([]);
      setRestaurantVotes([]);
      setRestaurantRoundMemberKeys([]);
      setRestaurantFinishedMemberKeys([]);
      setRoomMembers([]);
      setSwipePickLabel("");
      setActiveRoom(roomData as RoomRecord);
      syncRoomMembers(profile.full_name);
      setScreen("room");
    } catch (error) {
      setMessage(getErrorMessage(error, "Could not create room."));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleJoinRoom() {
    if (!supabase || !profile || !session?.user) return;
    setSubmitting(true);
    setMessage("");

    try {
      const candidates = roomCodeCandidates(roomCodeInput);
      if (candidates.length === 0) {
        throw new Error("Enter a valid room code.");
      }
      let roomData: RoomRecord | null = null;
      for (const code of candidates) {
        const lookup = await getRoomsTable().select("*").eq("code", code).maybeSingle();
        if (lookup.error) throw lookup.error;
        if (lookup.data) {
          roomData = lookup.data as RoomRecord;
          break;
        }
      }
      if (!roomData) throw new Error("Room not found.");

      const memberError = await insertRoomMember(roomData.id, profile.full_name, session.user.id);

      if (memberError && !memberError.message?.toLowerCase().includes("duplicate")) {
        throw memberError;
      }

      setRoomStage("lobby");
      setCategoryVotes([]);
      setRestaurantVotes([]);
      setRestaurantRoundMemberKeys([]);
      setRestaurantFinishedMemberKeys([]);
      setRoomMembers([]);
      setSwipePickLabel("");
      setActiveRoom(roomData as RoomRecord);
      syncRoomMembers(roomData.host_name);
      syncRoomMembers(profile.full_name);
      setScreen("room");

      broadcastRoomMemberJoined(supabase, roomData.id, profile.full_name, session.user.id);
      window.setTimeout(() => {
        broadcastRoomMemberJoined(supabase, roomData.id, profile.full_name, session.user.id);
      }, 1400);
    } catch (error) {
      setMessage(getErrorMessage(error, "Could not join room."));
    } finally {
      setSubmitting(false);
    }
  }

  const handleHostStartCategories = useCallback(() => {
    if (!isRoomHost) return;
    setRoomStage("categories");
    const roomId = activeRoom?.id;
    if (supabase && roomId) {
      void persistRoomFlowStage(supabase, roomId, "categories").then((r) => {
        if (!r.ok) setMessage(formatRoomFlowPersistUserMessage(r.reason));
      });
      broadcastRoomFlowEvent(supabase, roomId, "categories_started");
    }
  }, [isRoomHost, supabase, activeRoom?.id]);

  const handleHostStartRestaurantRound = useCallback(() => {
    if (!isRoomHost) return;
    const memberKeys = [...new Set(distinctRoomMembers.map((member) => restaurantPassParticipantKey(member)))];
    setRestaurantRoundMemberKeys(memberKeys);
    setRestaurantFinishedMemberKeys([]);
    setRoomStage("restaurants");
    const roomId = activeRoom?.id;
    if (supabase && roomId) {
      void (async () => {
        const passComplete = getRestaurantPassCompleteTable();
        if (passComplete) {
          await passComplete.delete().eq("room_id", roomId);
        }
        const r = await persistRoomFlowStage(supabase, roomId, "restaurants");
        if (!r.ok) setMessage(formatRoomFlowPersistUserMessage(r.reason));
        broadcastRoomFlowEvent(supabase, roomId, "restaurants_started", { member_keys: memberKeys });
      })();
    }
  }, [isRoomHost, distinctRoomMembers, supabase, activeRoom?.id, getRestaurantPassCompleteTable]);

  async function handleCategoryBatchSubmit(likeIds: readonly string[]) {
    if (!supabase || !activeRoom || !profile || !currentUserId) return;

    const likeSet = new Set(likeIds);
    const isMyVote = (vote: RoomCategoryVote) =>
      (currentUserId && vote.user_id === currentUserId) ||
      (vote.user_id == null && profile && vote.member_name === profile.full_name);

    const toSubmit = categories.filter(
      (cat) => !categoryVotes.some((vote) => vote.category_id === cat.id && isMyVote(vote)),
    );

    if (toSubmit.length === 0) {
      const votesSnapshot = categoryVotes;
      const myAnswered = new Set(votesSnapshot.filter(isMyVote).map((v) => v.category_id));
      if (myAnswered.size < categories.length) return;

      if (memberCount <= 1) {
        setRoomStage("restaurants");
        return;
      }

      const progress = buildMemberCategoryProgress(votesSnapshot);

      const everyoneDone =
        distinctRoomMembers.length > 0 &&
        distinctRoomMembers.every((member) => {
          const set = memberCategoryVotesSet(member, progress);
          return Boolean(set && set.size >= categoryDeckSize);
        });

      setRoomStage(everyoneDone ? "category_match" : "waiting_categories");
      return;
    }

    const optimistic: RoomCategoryVote[] = toSubmit.map((cat) => ({
      id: `local-cat-${cat.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      user_id: currentUserId,
      member_name: profile.full_name,
      category_id: cat.id,
      decision: likeSet.has(cat.id) ? "like" : "skip",
    }));

    const optimisticIds = new Set(optimistic.map((o) => o.id));

    const votesSnapshot = [
      ...categoryVotes.filter(
        (v) => !(isMyVote(v) && toSubmit.some((cat) => cat.id === v.category_id)),
      ),
      ...optimistic,
    ];

    setCategoryVotes((prev) => [
      ...prev.filter((v) => !(isMyVote(v) && toSubmit.some((cat) => cat.id === v.category_id))),
      ...optimistic,
    ]);

    try {
      for (const cat of toSubmit) {
        const insertError = await insertCategoryVote({
          room_id: activeRoom.id,
          user_id: currentUserId,
          member_name: profile.full_name,
          category_id: cat.id,
          decision: likeSet.has(cat.id) ? "like" : "skip",
        });

        if (insertError) throw insertError;
      }

      const likeCount = toSubmit.filter((c) => likeSet.has(c.id)).length;
      setSwipePickLabel(`Saved · ${likeCount} liked · ${toSubmit.length - likeCount} passed`);

      const myAnswered = new Set(votesSnapshot.filter(isMyVote).map((v) => v.category_id));
      if (myAnswered.size < categories.length) return;

      if (memberCount <= 1) {
        setRoomStage("restaurants");
        return;
      }

      const progress = buildMemberCategoryProgress(votesSnapshot);

      const everyoneDone =
        distinctRoomMembers.length > 0 &&
        distinctRoomMembers.every((member) => {
          const set = memberCategoryVotesSet(member, progress);
          return Boolean(set && set.size >= categoryDeckSize);
        });

      setRoomStage(everyoneDone ? "category_match" : "waiting_categories");
    } catch (error) {
      setCategoryVotes((prev) => prev.filter((v) => !optimisticIds.has(v.id)));
      setMessage(getErrorMessage(error, "Could not save your category picks."));
    }
  }

  async function handleRestaurantDecision(restaurantId: string, decision: "like" | "skip") {
    if (!supabase || !activeRoom || !profile || !currentUserId) return;

    const alreadyVoted = restaurantVotes.some(
      (vote) =>
        vote.restaurant_id === restaurantId &&
        (vote.user_id === currentUserId ||
          (vote.user_id == null && vote.member_name === profile.full_name)),
    );

    const optimisticId = `local-rest-${restaurantId}-${Date.now()}`;
    const optimistic: RoomRestaurantVote = {
      id: optimisticId,
      user_id: currentUserId,
      member_name: profile.full_name,
      restaurant_id: restaurantId,
      decision,
    };

    if (!alreadyVoted) {
      setRestaurantVotes((prev) => {
        if (
          prev.some(
            (vote) =>
              vote.restaurant_id === restaurantId &&
              (vote.user_id === currentUserId ||
                (vote.user_id == null && vote.member_name === profile.full_name)),
          )
        ) {
          return prev;
        }

        return [...prev, optimistic];
      });
    }

    const place =
      visibleCityRestaurants.find((r) => r.id === restaurantId) ??
      restaurantCandidates.find((r) => r.id === restaurantId);
    setSwipePickLabel(`${decision === "like" ? "Liked" : "Passed"} · ${place?.name ?? restaurantId}`);

    if (alreadyVoted) {
      return;
    }

    try {
      const insertError = await insertRestaurantVote({
        room_id: activeRoom.id,
        user_id: currentUserId,
        member_name: profile.full_name,
        restaurant_id: restaurantId,
        decision,
      });

      if (insertError) throw insertError;
    } catch (error) {
      setRestaurantVotes((prev) => prev.filter((v) => v.id !== optimisticId));
      setMessage(getErrorMessage(error, "Could not save your restaurant vote."));
      throw error;
    }
  }

  const persistProfileHidden = useCallback(
    async (nextHidden: HiddenPlace[]) => {
      if (!supabase || !session?.user) return;
      const p = profileRef.current;
      if (!p) return;
      const { data, error } = await getProfilesTable()
        .upsert({
          id: session.user.id,
          full_name: p.full_name,
          country_code: p.country_code,
          city: p.city,
          avatar_url: p.avatar_url,
          hidden_restaurants: nextHidden,
        })
        .select()
        .single();
      if (error) throw error;
      setProfile(profileFromDbRow(data as unknown as Record<string, unknown>));
    },
    [getProfilesTable, supabase, session?.user],
  );

  const restoreHiddenRestaurantIds = useCallback(
    async (ids: readonly string[]) => {
      const p = profileRef.current;
      if (!p || ids.length === 0) return;
      const drop = new Set(ids);
      const next = (p.hidden_restaurants ?? []).filter((h) => !drop.has(h.id));
      try {
        await persistProfileHidden(next);
        setMessage("");
      } catch (error) {
        setMessage(
          getErrorMessage(error, "Could not restore. Add the hidden_restaurants column (see Supabase migration)."),
        );
      }
    },
    [persistProfileHidden],
  );

  const clearUndoHideTimer = useCallback(() => {
    if (undoHideTimerRef.current != null) {
      window.clearTimeout(undoHideTimerRef.current);
      undoHideTimerRef.current = null;
    }
  }, []);

  const scheduleUndoHide = useCallback(
    (restaurant: CityRestaurant) => {
      clearUndoHideTimer();
      undoHidePlaceRef.current = restaurant;
      setUndoHidePlace(restaurant);
      undoHideTimerRef.current = window.setTimeout(() => {
        undoHidePlaceRef.current = null;
        setUndoHidePlace(null);
        undoHideTimerRef.current = null;
      }, 5500) as unknown as number;
    },
    [clearUndoHideTimer],
  );

  const handleUndoHide = useCallback(async () => {
    const place = undoHidePlaceRef.current;
    if (!place) return;
    undoHidePlaceRef.current = null;
    clearUndoHideTimer();
    setUndoHidePlace(null);
    try {
      await restoreHiddenRestaurantIds([place.id]);
      setSwipePickLabel(`Restored · ${place.name}`);
    } catch {
      /* restoreHiddenRestaurantIds sets message */
    }
  }, [clearUndoHideTimer, restoreHiddenRestaurantIds]);

  useEffect(() => {
    return () => {
      if (undoHideTimerRef.current != null) {
        window.clearTimeout(undoHideTimerRef.current);
      }
    };
  }, []);

  const hideRestaurantForever = useCallback(
    async (restaurant: CityRestaurant) => {
      const p = profileRef.current;
      if (!p) return;
      const prev = p.hidden_restaurants ?? [];
      if (prev.some((h) => h.id === restaurant.id)) return;
      try {
        await persistProfileHidden([...prev, { id: restaurant.id, name: restaurant.name }]);
        setRestaurantVotes((votes) => votes.filter((v) => v.restaurant_id !== restaurant.id));
        setSwipePickLabel("");
        scheduleUndoHide(restaurant);
      } catch (error) {
        setMessage(
          getErrorMessage(error, "Could not save. Add the hidden_restaurants column (see Supabase migration)."),
        );
      }
    },
    [persistProfileHidden, scheduleUndoHide],
  );

  const handleRestoreHiddenPlaces = useCallback(
    async (ids: readonly string[]) => {
      setSubmitting(true);
      try {
        await restoreHiddenRestaurantIds(ids);
      } finally {
        setSubmitting(false);
      }
    },
    [restoreHiddenRestaurantIds],
  );

  useEffect(() => {
    if (!supabase || !activeRoom) {
      return;
    }

    const client = supabase;
    const roomId = activeRoom.id;
    let active = true;

    async function loadMembers() {
      const { data, error } = await client
        .from("room_members")
        .select("id,name,joined_at,user_id")
        .eq("room_id", roomId)
        .order("joined_at", { ascending: true });

      if (!active) return;

      if (error) {
        return;
      }

      const rows = ((data as (RoomMember & { user_id?: string | null })[] | null) ?? [])
        .filter(Boolean)
        .map((row) => ({
          ...row,
          user_id: row.user_id ?? null,
        }));

      setRoomMembers((prev) => mergeMemberRowsFromServer(rows, prev));
    }

    function applyRemoteFlowStage(raw: string | undefined) {
      if (typeof raw !== "string" || !isRoomSyncFlowStage(raw)) return;
      setRoomStage((prev) => nextRoomStageFromSyncedFlow(prev, raw) ?? prev);
    }

    async function loadRoomFlow() {
      const { data, error } = await client.from("rooms").select("flow_stage").eq("id", roomId).maybeSingle();
      if (!active) return;
      if (error) {
        if (isMissingColumnError(error, "flow_stage")) return;
        return;
      }
      const raw = (data as { flow_stage?: string } | null)?.flow_stage;
      applyRemoteFlowStage(raw);
    }

    async function refreshMembersAndFlow() {
      await Promise.all([loadMembers(), loadRoomFlow()]);
    }

    void refreshMembersAndFlow();

    const staggerDelays = [300, 900, 2200];
    const staggerIds = staggerDelays.map((delay) =>
      window.setTimeout(() => {
        void refreshMembersAndFlow();
      }, delay),
    );

    const pollMs = screen === "room" ? 1200 : 3500;
    const pollId = window.setInterval(() => {
      void refreshMembersAndFlow();
    }, pollMs);

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void refreshMembersAndFlow();
      }
    };

    const onWindowFocus = () => {
      void refreshMembersAndFlow();
    };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onWindowFocus);

    const handshakeChannel = supabase
      .channel(`room-handshake-${roomId}`)
      .on(
        "broadcast",
        { event: "member_joined" },
        ({ payload }: { payload?: { name?: string; user_id?: string | null } }) => {
          if (!active) return;
          const name = payload?.name?.trim();
          if (!name) return;
          const uid = typeof payload?.user_id === "string" ? payload.user_id : null;
          setRoomMembers((prev) => {
            const addition: RoomMember = {
              id: `bc-${uid ?? `n:${name}`}`,
              name,
              user_id: uid,
              joined_at: new Date().toISOString(),
            };
            if (
              prev.some(
                (row) =>
                  (uid && row.user_id === uid) || roomMemberKey(row) === roomMemberKey(addition),
              )
            ) {
              return prev;
            }
            return [...prev, addition];
          });
          void loadMembers();
        },
      )
      .on("broadcast", { event: "categories_started" }, () => {
        if (!active) return;
        setRoomStage("categories");
      })
      .on("broadcast", { event: "final_results_started" }, () => {
        if (!active) return;
        setRoomStage("final");
      })
      .on(
        "broadcast",
        { event: "restaurants_started" },
        ({ payload }: { payload?: { member_keys?: unknown } }) => {
          if (!active) return;
          setRestaurantFinishedMemberKeys([]);
          const incoming = Array.isArray(payload?.member_keys)
            ? payload.member_keys.filter((row): row is string => typeof row === "string" && row.trim().length > 0)
            : [];
          if (incoming.length > 0) {
            setRestaurantRoundMemberKeys([...new Set(incoming.map((row) => row.trim()))]);
          } else {
            const members = distinctRoomMembersRef.current;
            setRestaurantRoundMemberKeys(
              [...new Set(members.map((member) => restaurantPassParticipantKey(member)))],
            );
          }
          setRoomStage("restaurants");
          void (
            client.from("room_restaurant_pass_complete") as unknown as RestaurantPassCompleteTable
          )
            .delete()
            .eq("room_id", roomId)
            .catch(() => undefined);
        },
      )
      .subscribe();

    const channel = supabase
      .channel(`room-members-${activeRoom.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "room_members",
          filter: `room_id=eq.${roomId}`,
        },
        () => {
          void loadMembers();
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "rooms",
          filter: `id=eq.${roomId}`,
        },
        (payload: { new?: Record<string, unknown> }) => {
          if (!active) return;
          const raw = payload.new?.flow_stage;
          applyRemoteFlowStage(typeof raw === "string" ? raw : undefined);
        },
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          void refreshMembersAndFlow();
        }
      });

    return () => {
      active = false;
      staggerIds.forEach((id) => window.clearTimeout(id));
      window.clearInterval(pollId);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onWindowFocus);
      void supabase.removeChannel(handshakeChannel);
      void supabase.removeChannel(channel);
    };
  }, [activeRoom, supabase, screen]);

  useEffect(() => {
    if (!supabase || !activeRoom) {
      return;
    }

    const client = supabase;
    const roomId = activeRoom.id;
    let active = true;

    async function loadCategoryVotes() {
      const primary = await client
        .from("room_category_votes")
        .select("id,user_id,category_id,decision,member_name")
        .eq("room_id", roomId)
        .order("created_at", { ascending: true });

      if (!active) return;

      if (primary.error) {
        if (isMissingColumnError(primary.error, "user_id")) {
          const legacy = await client
            .from("room_category_votes")
            .select("id,category_id,decision,member_name")
            .eq("room_id", roomId)
            .order("created_at", { ascending: true });

          if (!active) return;

          const rows = (legacy.data as Omit<RoomCategoryVote, "user_id">[] | null) ?? [];
          const normalized = rows.map((row) => ({ ...row, user_id: null as string | null }));
          setCategoryVotes((prev) => mergeCategoryVotesFromServer(normalized, prev));
        }

        return;
      }

      const rows = ((primary.data as RoomCategoryVote[] | null) ?? []).filter(Boolean);
      setCategoryVotes((prev) => mergeCategoryVotesFromServer(rows, prev));
    }

    async function loadRestaurantVotes() {
      const primary = await client
        .from("room_restaurant_votes")
        .select("id,user_id,restaurant_id,decision,member_name")
        .eq("room_id", roomId)
        .order("created_at", { ascending: true });

      if (!active) return;

      if (primary.error) {
        if (isMissingColumnError(primary.error, "user_id")) {
          const legacy = await client
            .from("room_restaurant_votes")
            .select("id,restaurant_id,decision,member_name")
            .eq("room_id", roomId)
            .order("created_at", { ascending: true });

          if (!active) return;

          const rows = (legacy.data as Omit<RoomRestaurantVote, "user_id">[] | null) ?? [];
          setRestaurantVotes((prev) =>
            mergeRestaurantVotesFromServer(
              rows.map((row) => ({ ...row, user_id: null })),
              prev,
            ),
          );
        }

        return;
      }

      const rows = ((primary.data as RoomRestaurantVote[] | null) ?? []).filter(Boolean);
      setRestaurantVotes((prev) => mergeRestaurantVotesFromServer(rows, prev));
    }

    async function loadRestaurantPassComplete() {
      const { data, error } = await client
        .from("room_restaurant_pass_complete")
        .select("participant_key")
        .eq("room_id", roomId);
      if (!active) return;
      if (error) return;
      const keys = ((data as { participant_key: string }[] | null) ?? []).map((row) => row.participant_key);
      setRestaurantFinishedMemberKeys((prev) => {
        const next = new Set(prev);
        for (const k of keys) next.add(k);
        return [...next];
      });
    }

    void loadCategoryVotes();
    void loadRestaurantVotes();
    void loadRestaurantPassComplete();

    let categoryReloadTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleCategoryVotesReload = () => {
      if (categoryReloadTimer) clearTimeout(categoryReloadTimer);
      categoryReloadTimer = setTimeout(() => {
        categoryReloadTimer = null;
        void loadCategoryVotes();
      }, 320);
    };

    const categoryChannel = supabase
      .channel(`room-category-votes-${roomId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "room_category_votes",
          filter: `room_id=eq.${roomId}`,
        },
        () => {
          scheduleCategoryVotesReload();
        },
      )
      .subscribe();

    const restaurantChannel = supabase
      .channel(`room-restaurant-votes-${roomId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "room_restaurant_votes",
          filter: `room_id=eq.${roomId}`,
        },
        () => {
          void loadRestaurantVotes();
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "room_restaurant_pass_complete",
          filter: `room_id=eq.${roomId}`,
        },
        () => {
          void loadRestaurantPassComplete();
        },
      )
      .subscribe();

    return () => {
      active = false;
      if (categoryReloadTimer) clearTimeout(categoryReloadTimer);
      void supabase.removeChannel(categoryChannel);
      void supabase.removeChannel(restaurantChannel);
    };
  }, [activeRoom, supabase]);

  useEffect(() => {
    if (!supabase || !activeRoom) {
      return;
    }
    if (roomStage !== "waiting_categories" && roomStage !== "categories") {
      return;
    }
    const roomId = activeRoom.id;
    const client = supabase;
    const poll = () => {
      void (async () => {
        const primary = await client
          .from("room_category_votes")
          .select("id,user_id,category_id,decision,member_name")
          .eq("room_id", roomId)
          .order("created_at", { ascending: true });
        if (primary.error) {
          if (isMissingColumnError(primary.error, "user_id")) {
            const legacy = await client
              .from("room_category_votes")
              .select("id,category_id,decision,member_name")
              .eq("room_id", roomId)
              .order("created_at", { ascending: true });
            if (legacy.error) return;
            const rows = (legacy.data as Omit<RoomCategoryVote, "user_id">[] | null) ?? [];
            const normalized = rows.map((row) => ({ ...row, user_id: null as string | null }));
            setCategoryVotes((prev) => mergeCategoryVotesFromServer(normalized, prev));
            return;
          }
          return;
        }
        const rows = ((primary.data as RoomCategoryVote[] | null) ?? []).filter(Boolean);
        setCategoryVotes((prev) => mergeCategoryVotesFromServer(rows, prev));
      })();
    };
    const pollId = window.setInterval(poll, 2500);
    return () => window.clearInterval(pollId);
  }, [activeRoom, supabase, roomStage]);

  useEffect(() => {
    if (roomStage !== "waiting_categories") {
      return;
    }
    if (memberCount <= 1) {
      setRoomStage("restaurants");
      return;
    }
    if (!allMembersFinishedCategories) {
      return;
    }
    setRoomStage("category_match");
  }, [roomStage, allMembersFinishedCategories, memberCount]);

  useEffect(() => {
    if (roomStage !== "category_match") {
      return;
    }
    if (memberCount <= 1) {
      setRoomStage("restaurants");
    }
  }, [roomStage, memberCount]);

  useEffect(() => {
    if (!activeRoom) {
      return;
    }
    if (roomStage !== "categories") {
      return;
    }
    if (pendingCategories.length > 0) {
      return;
    }
    if (memberCount <= 1) {
      setRoomStage("restaurants");
      return;
    }
    setRoomStage(allMembersFinishedCategories ? "category_match" : "waiting_categories");
  }, [activeRoom, roomStage, pendingCategories.length, memberCount, allMembersFinishedCategories]);

  useEffect(() => {
    if (roomStage !== "restaurants") return;
    if (restaurantRoundMemberKeys.length > 0) return;
    const keys = [...new Set(distinctRoomMembers.map((member) => restaurantPassParticipantKey(member)))];
    if (keys.length === 0) return;
    setRestaurantRoundMemberKeys(keys);
  }, [roomStage, restaurantRoundMemberKeys.length, distinctRoomMembers]);

  useEffect(() => {
    if (roomStage !== "restaurants") return;
    if (pendingRestaurants.length > 0) return;
    const memberKey = restaurantPassParticipantKeyForSelf(currentUserId, profile?.full_name);
    if (!memberKey) return;
    setRestaurantFinishedMemberKeys((prev) => (prev.includes(memberKey) ? prev : [...prev, memberKey]));
    if (!supabase || !activeRoom?.id) return;
    const passComplete = getRestaurantPassCompleteTable();
    if (!passComplete) return;
    void passComplete
      .upsert(
        { room_id: activeRoom.id, participant_key: memberKey },
        { onConflict: "room_id,participant_key" },
      )
      .then(({ error }) => {
        if (!error) return;
        if (/relation|does not exist|schema cache/i.test(error.message ?? "")) {
          return;
        }
        setMessage(
          getErrorMessage(
            error,
            "Could not record that you finished restaurants. Check Supabase policies for room_restaurant_pass_complete (insert + update for upsert).",
          ),
        );
      });
  }, [
    roomStage,
    pendingRestaurants.length,
    profile?.full_name,
    currentUserId,
    supabase,
    activeRoom?.id,
    getRestaurantPassCompleteTable,
  ]);

  useEffect(() => {
    if (!supabase || !activeRoom) {
      return;
    }
    if (roomStage !== "restaurants") {
      return;
    }
    if (memberCount <= 1) {
      return;
    }
    const client = supabase;
    const roomId = activeRoom.id;
    let active = true;
    const pollPass = () => {
      void (async () => {
        const { data, error } = await client
          .from("room_restaurant_pass_complete")
          .select("participant_key")
          .eq("room_id", roomId);
        if (!active || error) {
          return;
        }
        const keys = ((data as { participant_key: string }[] | null) ?? []).map((row) => row.participant_key);
        setRestaurantFinishedMemberKeys((prev) => {
          const next = new Set(prev);
          for (const k of keys) {
            next.add(k);
          }
          return [...next];
        });
      })();
    };
    pollPass();
    const intervalId = window.setInterval(pollPass, 2000);
    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [supabase, activeRoom, roomStage, memberCount]);

  useEffect(() => {
    if (!supabase || !activeRoom || roomStage !== "final") {
      return;
    }
    const client = supabase;
    const roomId = activeRoom.id;
    let cancelled = false;

    void (async () => {
      const primary = await client
        .from("room_restaurant_votes")
        .select("id,user_id,restaurant_id,decision,member_name")
        .eq("room_id", roomId)
        .order("created_at", { ascending: true });
      if (cancelled) return;

      if (primary.error) {
        if (isMissingColumnError(primary.error, "user_id")) {
          const legacy = await client
            .from("room_restaurant_votes")
            .select("id,restaurant_id,decision,member_name")
            .eq("room_id", roomId)
            .order("created_at", { ascending: true });
          if (cancelled || legacy.error) return;
          const rows = (legacy.data as Omit<RoomRestaurantVote, "user_id">[] | null) ?? [];
          setRestaurantVotes((prev) =>
            mergeRestaurantVotesFromServer(
              rows.map((row) => ({ ...row, user_id: null })),
              prev,
            ),
          );
        }
        return;
      }

      const rows = ((primary.data as RoomRestaurantVote[] | null) ?? []).filter(Boolean);
      setRestaurantVotes((prev) => mergeRestaurantVotesFromServer(rows, prev));
    })();

    return () => {
      cancelled = true;
    };
  }, [supabase, activeRoom, roomStage]);

  const restaurantFetchContextRef = useRef({
    roomStage,
    restaurantFocusCategoryIds,
    soloLikedCategoryIds,
    memberCount,
  });
  restaurantFetchContextRef.current = {
    roomStage,
    restaurantFocusCategoryIds,
    soloLikedCategoryIds,
    memberCount,
  };

  useEffect(() => {
    if (!activeRoom) {
      setRestaurantsLoading(false);
      return;
    }

    let active = true;
    const controller = new AbortController();
    const roomCity = activeRoom.city;
    const roomCountry = activeRoom.country_code;

    async function loadRestaurants() {
      const ctx = restaurantFetchContextRef.current;
      const enrich =
        ctx.roomStage === "restaurants" || ctx.roomStage === "final" || ctx.roomStage === "category_match";
      const focusIds =
        ctx.restaurantFocusCategoryIds.length > 0
          ? ctx.restaurantFocusCategoryIds
          : ctx.memberCount <= 1
            ? ctx.soloLikedCategoryIds
            : [];

      setRestaurantsLoading(true);
      try {
        const params = new URLSearchParams({
          city: roomCity,
          country: roomCountry,
        });

        if (enrich && focusIds.length > 0) {
          params.set("likedCategories", focusIds.join(","));
        }

        const response = await fetch(`/api/restaurants?${params.toString()}`, {
          signal: controller.signal,
        });

        const payload = (await response.json()) as {
          places?: CityRestaurant[];
          error?: string;
        };

        if (!active) return;

        if (!response.ok) {
          setMessage(payload.error ?? "Could not load restaurants for this city.");
          return;
        }

        let places = payload.places ?? [];

        if (enrich && focusIds.length > 0 && places.length === 0 && !controller.signal.aborted) {
          const fallbackParams = new URLSearchParams({
            city: roomCity,
            country: roomCountry,
          });
          const fallbackRes = await fetch(`/api/restaurants?${fallbackParams.toString()}`, {
            signal: controller.signal,
          });
          const fallbackPayload = (await fallbackRes.json()) as {
            places?: CityRestaurant[];
            error?: string;
          };
          if (fallbackRes.ok) {
            places = fallbackPayload.places ?? [];
          }
        }

        if (!active) return;
        setCityRestaurants(places);
      } catch (error) {
        if (!active || controller.signal.aborted) return;
        setMessage(getErrorMessage(error, "Could not load restaurants."));
      } finally {
        if (active) {
          setRestaurantsLoading(false);
        }
      }
    }

    void loadRestaurants();

    return () => {
      active = false;
      controller.abort();
      setRestaurantsLoading(false);
    };
  }, [activeRoom, diningPlacesFetchKey]);

  const pendingRestaurantPrefetchKey = useMemo(
    () => pendingRestaurants.map((r) => r.id).join("|"),
    [pendingRestaurants],
  );
  const pendingRestaurantsRef = useRef(pendingRestaurants);
  pendingRestaurantsRef.current = pendingRestaurants;

  useEffect(() => {
    if (roomStage !== "restaurants" || typeof window === "undefined") return;
    for (const place of pendingRestaurantsRef.current.slice(0, 12)) {
      const url = place.photoUrls?.[0];
      if (!url) continue;
      const img = new window.Image();
      img.decoding = "async";
      img.src = url;
    }
  }, [roomStage, pendingRestaurantPrefetchKey]);

  if (loading) {
    return (
      <main className={`grid h-[100dvh] place-items-center overflow-hidden ${uiPage} text-white`}>
        <div className="text-center">
          <p className="text-sm uppercase tracking-[0.28em] text-white/45">BiteSync</p>
          <h1 className="mt-4 text-4xl font-semibold">Loading...</h1>
        </div>
      </main>
    );
  }

  return (
    <main className={`h-[100dvh] overflow-hidden ${uiPage} text-white`}>
      <div className="mx-auto flex h-full w-full max-w-[460px] flex-col px-3 py-3 sm:px-4 sm:py-4">
        <div className={`relative flex h-full min-h-0 flex-col overflow-hidden ${uiShell}`}>
          <AppHeader
            profile={profile}
            screen={screen}
            menuOpen={menuOpen}
            menuRef={menuRef}
            onToggleMenu={() => setMenuOpen((prev) => !prev)}
            onOpenProfile={() => {
              setMenuOpen(false);
              setScreen("profile");
            }}
            onOpenHiddenPlaces={
              hasSupabaseEnv
                ? () => {
                    setMenuOpen(false);
                    setScreen("hidden_places");
                  }
                : undefined
            }
            hiddenPlaceCount={(profile?.hidden_restaurants ?? []).length}
            onSignOut={handleSignOut}
          />

          {!hasSupabaseEnv ? (
            <div className="px-4 pt-3">
              <div className="rounded-2xl border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
                Add Supabase env keys to enable sign-in, profiles, and rooms.
              </div>
            </div>
          ) : null}

          {supabaseConfigError ? (
            <div className="px-4 pt-3">
              <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-100">
                {supabaseConfigError}
              </div>
            </div>
          ) : null}

          {message ? (
            <div className="px-4 pt-3">
              <div className="rounded-2xl border border-white/10 bg-white/6 px-4 py-3 text-sm text-white/80">
                {message}
              </div>
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-hidden px-4 pb-4 pt-4">
            {screen === "auth" ? (
              <AuthScreen
                mode={authMode}
                email={email}
                password={password}
                fullName={fullName}
                countryCode={countryCode}
                city={city}
                submitting={submitting}
                onModeChange={setAuthMode}
                onEmailChange={setEmail}
                onPasswordChange={setPassword}
                onFullNameChange={setFullName}
                onCountryChange={setCountryCode}
                onCityChange={setCity}
                onSubmit={handleAuthSubmit}
              />
            ) : null}

            {screen === "home" ? (
              <HomeScreen
                profile={profile}
                roomCodeInput={roomCodeInput}
                submitting={submitting}
                onRoomCodeChange={setRoomCodeInput}
                onHost={handleHostRoom}
                onJoin={handleJoinRoom}
              />
            ) : null}

            {screen === "hidden_places" ? (
              <HiddenPlacesScreen
                items={profile?.hidden_restaurants ?? []}
                submitting={submitting}
                onBack={() => setScreen("home")}
                onRestore={handleRestoreHiddenPlaces}
              />
            ) : null}

            {screen === "profile" ? (
              <ProfileScreen
                profile={profile}
                email={email}
                fullName={fullName}
                countryCode={countryCode}
                city={city}
                submitting={submitting}
                avatarUploading={avatarUploading}
                fileInputRef={fileInputRef}
                onBack={() => setScreen("home")}
                onEmailChange={setEmail}
                onFullNameChange={setFullName}
                onCountryChange={setCountryCode}
                onCityChange={setCity}
                onPickAvatar={() => fileInputRef.current?.click()}
                onFileChange={(file) => file && handleAvatarUpload(file)}
                onSave={handleSaveProfile}
              />
            ) : null}

            {screen === "room" ? (
              <RoomScreen
                room={activeRoom}
                isRoomHost={isRoomHost}
                stage={roomStage}
                roomMembers={distinctRoomMembers}
                expectedRestaurantMemberCount={restaurantRoundExpectedMemberKeys.length}
                sharedMatchCategories={sharedMatchCategories}
                restaurantFocusCategories={restaurantFocusCategories}
                membersStillSwipingCategories={membersStillSwipingCategories}
                membersStillSwipingRestaurants={membersStillSwipingRestaurants}
                allMembersFinishedRestaurants={allMembersFinishedRestaurants}
                pendingCategories={pendingCategories}
                pendingRestaurants={pendingRestaurants}
                mutualFinalRestaurants={mutualFinalRestaurants}
                partialCoLikedFinalRows={partialCoLikedFinalRows}
                soloLikedFinalRows={soloLikedFinalRows}
                restaurantsLoading={restaurantsLoading}
                loadedPlaceCount={visibleCityRestaurants.length}
                swipePickLabel={swipePickLabel}
                myCategoryVotes={myCategoryVotes}
                onStart={handleHostStartCategories}
                onStartRestaurantRound={handleHostStartRestaurantRound}
                onCategoryBatchSubmit={handleCategoryBatchSubmit}
                onRestaurantDecision={handleRestaurantDecision}
                onShowFinalResults={handleHostShowFinalResults}
                onRestartCategories={handleHostRestartCategories}
                onRestartRestaurants={handleHostRestartRestaurants}
                onHideRestaurantForever={hasSupabaseEnv ? hideRestaurantForever : undefined}
                onRetryPlaces={() => setPlacesFetchNonce((n) => n + 1)}
                onBack={() => {
                  setSwipePickLabel("");
                  setScreen("home");
                  setRoomStage("lobby");
                  setRestaurantRoundMemberKeys([]);
                  setRestaurantFinishedMemberKeys([]);
                }}
              />
            ) : null}
          </div>

          {undoHidePlace ? (
            <div className={`pointer-events-auto absolute inset-x-3 bottom-3 z-[60] flex items-center justify-between gap-3 px-4 py-3 ${uiToastBar}`}>
              <p className="min-w-0 flex-1 truncate text-sm text-white/88">
                Hidden: <span className="font-semibold text-white">{undoHidePlace.name}</span>
              </p>
              <button
                type="button"
                onClick={() => void handleUndoHide()}
                className="shrink-0 rounded-full bg-white px-4 py-2 text-sm font-semibold text-stone-950 transition hover:bg-white/90"
              >
                Undo
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </main>
  );
}

function AppHeader({
  profile,
  screen,
  menuOpen,
  menuRef,
  onToggleMenu,
  onOpenProfile,
  onOpenHiddenPlaces,
  hiddenPlaceCount,
  onSignOut,
}: {
  profile: Profile | null;
  screen: Screen;
  menuOpen: boolean;
  menuRef: React.RefObject<HTMLDivElement | null>;
  onToggleMenu: () => void;
  onOpenProfile: () => void;
  onOpenHiddenPlaces?: () => void;
  hiddenPlaceCount?: number;
  onSignOut: () => void;
}) {
  const subtitle =
    screen === "auth"
      ? "Real account"
      : screen === "profile"
        ? "Your profile"
        : screen === "room"
          ? "Room ready"
          : screen === "hidden_places"
            ? "Hidden places"
            : "Choose a path";

  return (
    <div className="flex items-center justify-between border-b border-white/10 px-4 py-4">
      <div>
        <p className="text-xs uppercase tracking-[0.26em] text-white/38">BiteSync</p>
        <p className="mt-1 text-sm text-white/70">{subtitle}</p>
      </div>

      {profile ? (
        <div className="flex min-w-0 max-w-[62%] items-center gap-3 sm:max-w-[70%]" ref={menuRef}>
          {screen !== "auth" ? (
            <p className="min-w-0 flex-1 truncate text-right text-sm font-semibold text-white">{profile.full_name}</p>
          ) : null}
          <div className="relative shrink-0">
            <button
              onClick={onToggleMenu}
              className="h-11 w-11 overflow-hidden rounded-full border border-white/12 bg-white/10"
            >
              {profile.avatar_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={profile.avatar_url} alt={profile.full_name} className="h-full w-full object-cover" />
              ) : (
                <div className="grid h-full w-full place-items-center text-sm font-semibold text-white">
                  {getInitials(profile.full_name)}
                </div>
              )}
            </button>

            {menuOpen ? (
              <div className={`absolute right-0 top-14 z-20 p-2 ${uiPopover} ${onOpenHiddenPlaces ? "w-52" : "w-44"}`}>
                <button onClick={onOpenProfile} className={menuItemClass}>
                  Profile
                </button>
                {onOpenHiddenPlaces ? (
                  <button
                    type="button"
                    onClick={onOpenHiddenPlaces}
                    className={menuItemClass}
                  >
                    Hidden places
                    {typeof hiddenPlaceCount === "number" && hiddenPlaceCount > 0
                      ? ` (${hiddenPlaceCount})`
                      : ""}
                  </button>
                ) : null}
                <button onClick={onSignOut} className={menuItemClass}>
                  Sign out
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AuthScreen({
  mode,
  email,
  password,
  fullName,
  countryCode,
  city,
  submitting,
  onModeChange,
  onEmailChange,
  onPasswordChange,
  onFullNameChange,
  onCountryChange,
  onCityChange,
  onSubmit,
}: {
  mode: AuthMode;
  email: string;
  password: string;
  fullName: string;
  countryCode: string;
  city: string;
  submitting: boolean;
  onModeChange: (value: AuthMode) => void;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onFullNameChange: (value: string) => void;
  onCountryChange: (value: string) => void;
  onCityChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const isSignIn = mode === "signin";

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden">
      <div>
        <div className="inline-flex rounded-full border border-white/10 bg-white/6 p-1">
          <button
            onClick={() => onModeChange("signup")}
            className={`rounded-full px-3 py-1.5 text-sm font-semibold ${mode === "signup" ? "bg-white text-stone-950" : "text-white/65"}`}
          >
            Sign up
          </button>
          <button
            onClick={() => onModeChange("signin")}
            className={`rounded-full px-3 py-1.5 text-sm font-semibold ${mode === "signin" ? "bg-white text-stone-950" : "text-white/65"}`}
          >
            Sign in
          </button>
        </div>

        <h1 className="mt-3 text-[1.75rem] font-semibold leading-tight text-white sm:text-3xl">
          {mode === "signup" ? "Create your account" : "Welcome back"}
        </h1>
        <p className={`mt-2 text-sm text-white/58 ${isSignIn ? "leading-5" : "leading-6"}`}>
          {mode === "signup" ? "One account — host or join rooms anytime." : "Pick up where you left off."}
        </p>
      </div>

      <div className={`min-h-0 ${isSignIn ? "" : "flex-1 overflow-y-auto"}`}>
        <div className={`pb-2 ${isSignIn ? "space-y-2.5" : "space-y-3"}`}>
          {mode === "signup" ? (
            <>
              <Field label="Full name">
                <input value={fullName} onChange={(event) => onFullNameChange(event.target.value)} className={fieldClass} placeholder="Your name" />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Country">
                  <select value={countryCode} onChange={(event) => onCountryChange(event.target.value)} className={fieldClass}>
                    {countries.map((country) => (
                      <option key={country.code} value={country.code}>
                        {country.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="City">
                  <input value={city} onChange={(event) => onCityChange(event.target.value)} className={fieldClass} placeholder="City" />
                </Field>
              </div>
            </>
          ) : null}

          <Field label="Email">
            <input value={email} onChange={(event) => onEmailChange(event.target.value)} className={fieldClass} placeholder="you@example.com" type="email" />
          </Field>
          <Field label="Password">
            <input value={password} onChange={(event) => onPasswordChange(event.target.value)} className={fieldClass} placeholder="Password" type="password" />
          </Field>
        </div>
      </div>

      <button onClick={onSubmit} disabled={submitting} className={`mt-auto ${primaryButtonCompactClass}`}>
        {submitting ? "Please wait..." : mode === "signup" ? "Create account" : "Sign in"}
      </button>
    </div>
  );
}

function HiddenPlacesScreen({
  items,
  submitting,
  onBack,
  onRestore,
}: {
  items: HiddenPlace[];
  submitting: boolean;
  onBack: () => void;
  onRestore: (ids: readonly string[]) => void | Promise<void>;
}) {
  const [checkedRestore, setCheckedRestore] = useState<Set<string>>(() => new Set(items.map((i) => i.id)));

  useEffect(() => {
    setCheckedRestore(new Set(items.map((i) => i.id)));
  }, [items]);

  const toggle = (id: string) => {
    setCheckedRestore((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden">
      <button type="button" onClick={onBack} className={ghostButtonClass}>
        Back
      </button>
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold text-white">Hidden places</h1>
        <p className="mt-2 text-sm leading-relaxed text-white/60">
          Checked = back in your deck. Select all, then uncheck what should stay hidden.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setCheckedRestore(new Set(items.map((i) => i.id)))}
          className="rounded-full border border-white/14 bg-white/8 px-4 py-2 text-sm font-semibold text-white/88 transition hover:bg-white/12"
        >
          Select all
        </button>
        <button
          type="button"
          onClick={() => setCheckedRestore(new Set())}
          className="rounded-full border border-white/14 bg-white/8 px-4 py-2 text-sm font-semibold text-white/88 transition hover:bg-white/12"
        >
          Clear checks
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain pr-0.5">
        {items.length === 0 ? (
          <p className="rounded-2xl border border-white/10 bg-white/6 px-4 py-4 text-sm text-white/55">
            Nothing here yet. On a card, use Hide forever to drop it from suggestions.
          </p>
        ) : (
          items.map((item) => (
            <label
              key={item.id}
              className="flex cursor-pointer items-center gap-3 rounded-2xl border border-white/10 bg-white/6 px-4 py-3.5 transition hover:bg-white/9"
            >
              <input
                type="checkbox"
                checked={checkedRestore.has(item.id)}
                onChange={() => toggle(item.id)}
                className="h-5 w-5 shrink-0 rounded border-white/30 text-orange-400 focus:ring-orange-400/40"
              />
              <span className="min-w-0 flex-1 text-sm font-medium leading-snug text-white">{item.name}</span>
            </label>
          ))
        )}
      </div>
      <button
        type="button"
        disabled={submitting || checkedRestore.size === 0}
        onClick={() => void Promise.resolve(onRestore([...checkedRestore]))}
        className={primaryButtonClass}
      >
        {submitting ? "Saving…" : "Restore checked"}
      </button>
    </div>
  );
}

function HomeScreen({
  profile,
  roomCodeInput,
  submitting,
  onRoomCodeChange,
  onHost,
  onJoin,
}: {
  profile: Profile | null;
  roomCodeInput: string;
  submitting: boolean;
  onRoomCodeChange: (value: string) => void;
  onHost: () => void;
  onJoin: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-5 overflow-hidden">
      <div className="rounded-[28px] bg-[linear-gradient(135deg,#ff7a18_0%,#ff4d8d_52%,#8f6bff_100%)] p-[1px]">
        <div className={`rounded-[27px] p-5 ${uiInset}`}>
          <p className="text-sm text-white/55">Signed in as</p>
          <h1 className="mt-2 text-3xl font-semibold text-white">{profile?.full_name}</h1>
          <p className="mt-2 text-sm text-white/58">
            {profile?.city}, {profile?.country_code}
          </p>
        </div>
      </div>

      <div className="grid gap-3">
        <button onClick={onHost} disabled={submitting} className={primaryCardClass}>
          <p className="text-sm text-white/65">New room for your group</p>
          <p className="mt-1 text-2xl font-semibold">Host a room</p>
        </button>

        <div className="rounded-[28px] border border-white/10 bg-white/6 p-4">
          <p className="text-sm text-white/58">Already have a room code?</p>
          <input
            value={roomCodeInput}
            onChange={(event) => onRoomCodeChange(formatRoomCodeInput(event.target.value))}
            className={`${fieldClass} mt-4 text-center text-2xl font-semibold tracking-[0.24em]`}
            placeholder="CALG - 571"
          />
          <button onClick={onJoin} disabled={submitting} className="mt-4 w-full rounded-full bg-white px-5 py-4 font-semibold text-stone-950">
            Join room
          </button>
        </div>
      </div>
    </div>
  );
}

function ProfileScreen({
  profile,
  email,
  fullName,
  countryCode,
  city,
  submitting,
  avatarUploading,
  fileInputRef,
  onBack,
  onEmailChange,
  onFullNameChange,
  onCountryChange,
  onCityChange,
  onPickAvatar,
  onFileChange,
  onSave,
}: {
  profile: Profile | null;
  email: string;
  fullName: string;
  countryCode: string;
  city: string;
  submitting: boolean;
  avatarUploading: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onBack: () => void;
  onEmailChange: (value: string) => void;
  onFullNameChange: (value: string) => void;
  onCountryChange: (value: string) => void;
  onCityChange: (value: string) => void;
  onPickAvatar: () => void;
  onFileChange: (file: File | null) => void;
  onSave: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-5 overflow-hidden">
      <div className="flex items-center justify-between">
        <button onClick={onBack} className={ghostButtonClass}>
          Back
        </button>
        <span className="rounded-full border border-white/10 bg-white/6 px-4 py-2 text-xs uppercase tracking-[0.24em] text-white/70">
          Profile
        </span>
      </div>

      <div>
        <h1 className="text-3xl font-semibold text-white">Your profile</h1>
        <p className="mt-2 text-sm leading-7 text-white/58">Name, city, and photo are used when you host or join.</p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-4 pb-2">
          <div className="flex items-center gap-4 rounded-[28px] border border-white/10 bg-white/6 p-4">
            <div className="h-18 w-18 overflow-hidden rounded-full border border-white/10 bg-white/10">
              {profile?.avatar_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={profile.avatar_url} alt={profile.full_name} className="h-full w-full object-cover" />
              ) : (
                <div className="grid h-full w-full place-items-center text-lg font-semibold text-white">
                  {getInitials(fullName || "BiteSync User")}
                </div>
              )}
            </div>
            <div className="flex-1">
              <p className="text-sm text-white/55">Profile picture</p>
              <button onClick={onPickAvatar} className="mt-2 text-sm font-semibold text-orange-300">
                {avatarUploading ? "Uploading..." : "Upload photo"}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(event) => onFileChange(event.target.files?.[0] ?? null)}
              />
            </div>
          </div>

          <Field label="Full name">
            <input value={fullName} onChange={(event) => onFullNameChange(event.target.value)} className={fieldClass} />
          </Field>

          <Field label="Email">
            <input value={email} onChange={(event) => onEmailChange(event.target.value)} className={fieldClass} type="email" />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Country">
              <select value={countryCode} onChange={(event) => onCountryChange(event.target.value)} className={fieldClass}>
                {countries.map((country) => (
                  <option key={country.code} value={country.code}>
                    {country.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="City">
              <input value={city} onChange={(event) => onCityChange(event.target.value)} className={fieldClass} />
            </Field>
          </div>
        </div>
      </div>

      <button onClick={onSave} disabled={submitting} className={primaryButtonClass}>
        {submitting ? "Saving..." : "Save profile"}
      </button>
    </div>
  );
}

function placePhotoWithSize(src: string, w: number, h: number) {
  if (typeof window === "undefined" || !src.includes("places-photo")) return src;
  try {
    const u = new URL(src, window.location.origin);
    u.searchParams.set("w", String(w));
    u.searchParams.set("h", String(h));
    return `${u.pathname}${u.search}`;
  } catch {
    return src;
  }
}

/** Rich place line for web search: name + full address + room city (helps matching). */
function deliveryGoogleContext(restaurant: CityRestaurant, roomCity: string): string {
  const name = restaurant.name?.trim() || "restaurant";
  const addr = restaurant.address?.trim() || "";
  const cityLine = roomCity.split(/[|;]/)[0]?.trim() || roomCity.trim();
  const parts = [name, addr, cityLine].filter(Boolean);
  let s = parts.join(" ");
  if (s.length > 200) s = s.slice(0, 197).trimEnd() + "…";
  return s;
}

function googleSearchUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

/** Native in-app search URLs are unreliable; Google always runs a real name search. */
function deliveryUberEatsGoogleUrl(ctx: string, countryCode: string): string {
  const cc = countryCode.toUpperCase();
  const region =
    cc === "CA" ? "Canada" : cc === "GB" || cc === "UK" ? "UK" : cc === "AU" ? "Australia" : "USA";
  return googleSearchUrl(`${ctx} Uber Eats ${region}`);
}

function deliveryDoorDashGoogleUrl(ctx: string, countryCode: string): string {
  const cc = countryCode.toUpperCase();
  const region =
    cc === "CA" ? "Canada" : cc === "GB" || cc === "UK" ? "UK" : cc === "AU" ? "Australia" : "USA";
  return googleSearchUrl(`${ctx} DoorDash ${region}`);
}

function deliverySkipGoogleUrl(ctx: string, countryCode: string): string {
  const cc = countryCode.toUpperCase();
  if (cc === "CA") return googleSearchUrl(`${ctx} SkipTheDishes Canada`);
  return googleSearchUrl(`${ctx} Skip The Dishes`);
}

function DeliveryOrderLinks({
  restaurant,
  countryCode,
  city,
}: {
  restaurant: CityRestaurant;
  countryCode: string;
  city: string;
}) {
  const ctx = deliveryGoogleContext(restaurant, city);
  const cc = countryCode?.trim() || "US";
  const ue = deliveryUberEatsGoogleUrl(ctx, cc);
  const dd = deliveryDoorDashGoogleUrl(ctx, cc);
  const st = deliverySkipGoogleUrl(ctx, cc);
  const linkClass =
    "inline-flex min-h-[2.5rem] flex-1 items-center justify-center gap-1.5 rounded-xl border px-2.5 py-2 text-center text-[11px] font-semibold leading-tight text-white/95 shadow-sm transition hover:brightness-[1.08] active:scale-[0.98] sm:text-xs";
  return (
    <div className="space-y-2">
      <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-white/40">Order online</p>
      <p className="text-[10px] leading-snug text-white/38">Opens Google with this place + app name so search matches the listing.</p>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <a
          href={ue}
          target="_blank"
          rel="noopener noreferrer"
          className={`${linkClass} border-emerald-400/35 bg-emerald-600/20 text-emerald-50`}
        >
          Uber Eats
        </a>
        <a
          href={dd}
          target="_blank"
          rel="noopener noreferrer"
          className={`${linkClass} border-rose-400/35 bg-rose-600/22 text-rose-50`}
        >
          DoorDash
        </a>
        <a
          href={st}
          target="_blank"
          rel="noopener noreferrer"
          className={`${linkClass} border-orange-400/35 bg-orange-600/20 text-orange-50`}
        >
          SkipTheDishes
        </a>
      </div>
    </div>
  );
}

const RestaurantSwipeCard = memo(function RestaurantSwipeCardInner({
  restaurant,
  heroImagePriority = "low",
  onHideForever,
}: {
  restaurant: CityRestaurant;
  heroImagePriority?: "high" | "low";
  onHideForever?: (place: CityRestaurant) => void | Promise<void>;
}) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const photos = restaurant.photoUrls ?? [];
  const extraPhotos = photos.slice(1);
  const heroTapRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const lightboxSwipeX0 = useRef<number | null>(null);
  const lbPrevIdxRef = useRef<number | null>(null);
  const [lbAnim, setLbAnim] = useState<{ opacity: number; tx: number; transition: string }>({
    opacity: 1,
    tx: 0,
    transition: "none",
  });

  useEffect(() => {
    setLightboxIndex(null);
    setMenuOpen(false);
  }, [restaurant.id]);

  const lightboxOpen = lightboxIndex !== null && photos.length > 0;
  const lightboxSrc =
    lightboxOpen && lightboxIndex !== null ? placePhotoWithSize(photos[lightboxIndex]!, 1280, 960) : null;
  const canPrev = lightboxIndex !== null && lightboxIndex > 0;
  const canNext = lightboxIndex !== null && lightboxIndex < photos.length - 1;

  useEffect(() => {
    if (!lightboxOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [lightboxOpen]);

  useEffect(() => {
    if (!lightboxOpen || lightboxIndex === null) {
      lbPrevIdxRef.current = null;
      setLbAnim({ opacity: 1, tx: 0, transition: "none" });
      return;
    }
    if (photos.length === 0) return;
    const prev = lbPrevIdxRef.current;
    lbPrevIdxRef.current = lightboxIndex;
    if (prev === null) {
      setLbAnim({ opacity: 1, tx: 0, transition: "opacity 180ms ease-out" });
      return;
    }
    if (prev === lightboxIndex) return;
    const fromX = lightboxIndex > prev ? 36 : -36;
    setLbAnim({ opacity: 1, tx: fromX, transition: "none" });
    const id = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        setLbAnim({
          opacity: 1,
          tx: 0,
          transition: "transform 300ms cubic-bezier(0.22, 1, 0.36, 1)",
        });
      });
    });
    return () => window.cancelAnimationFrame(id);
  }, [lightboxOpen, lightboxIndex, photos.length]);

  useEffect(() => {
    if (!lightboxOpen || photos.length === 0) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setLightboxIndex(null);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        setLightboxIndex((i) => (i !== null ? Math.max(0, i - 1) : i));
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        setLightboxIndex((i) => (i !== null ? Math.min(photos.length - 1, i + 1) : i));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [lightboxOpen, photos.length]);

  const lightbox =
    lightboxSrc &&
    lightboxIndex !== null &&
    createPortal(
      <div
        className="fixed inset-0 z-[240] flex flex-col bg-black/90 p-3 sm:p-5"
        role="dialog"
        aria-modal="true"
        aria-label="Photos"
        onPointerDown={(event) => event.stopPropagation()}
        onPointerMove={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
        onPointerCancel={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          if (event.target === event.currentTarget) {
            setLightboxIndex(null);
          }
        }}
      >
        <button
          type="button"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => setLightboxIndex(null)}
          className="absolute right-3 top-3 z-10 rounded-full border border-white/20 bg-white/10 px-3 py-1.5 text-xs font-semibold text-white/90 backdrop-blur-sm transition hover:bg-white/16"
        >
          Close
        </button>
        {photos.length > 1 ? (
          <p className="pointer-events-none absolute left-1/2 top-14 z-10 -translate-x-1/2 text-xs text-white/55">
            {lightboxIndex + 1} / {photos.length}
          </p>
        ) : null}
        {onHideForever ? (
          <button
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              void Promise.resolve(onHideForever(restaurant)).then(() => setLightboxIndex(null));
            }}
            className="absolute bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 z-20 max-w-[min(92vw,360px)] -translate-x-1/2 rounded-full border border-rose-400/35 bg-rose-500/20 px-4 py-2.5 text-xs font-semibold text-rose-100 shadow-lg backdrop-blur-sm transition hover:bg-rose-500/30"
          >
            Hide forever
          </button>
        ) : null}
        <div
          className={`relative flex min-h-0 flex-1 items-center justify-center pt-10 ${onHideForever ? "pb-24" : ""}`}
          style={photos.length > 1 ? { touchAction: "none" } : undefined}
          onPointerDown={(event) => {
            event.stopPropagation();
            if (photos.length < 2) return;
            lightboxSwipeX0.current = event.clientX;
          }}
          onPointerUp={(event) => {
            event.stopPropagation();
            const x0 = lightboxSwipeX0.current;
            lightboxSwipeX0.current = null;
            if (x0 == null || photos.length < 2) return;
            const dx = event.clientX - x0;
            if (Math.abs(dx) < 56) return;
            if (dx > 0) {
              setLightboxIndex((i) => (i !== null && i > 0 ? i - 1 : i));
            } else {
              setLightboxIndex((i) => (i !== null && i < photos.length - 1 ? i + 1 : i));
            }
          }}
          onPointerCancel={(event) => {
            event.stopPropagation();
            lightboxSwipeX0.current = null;
          }}
        >
          {photos.length > 1 ? (
            <>
              <button
                type="button"
                aria-label="Previous photo"
                disabled={!canPrev}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  setLightboxIndex((i) => (i !== null && i > 0 ? i - 1 : i));
                }}
                className="absolute left-1 top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-white/20 bg-white/10 text-lg text-white/90 backdrop-blur-sm transition hover:bg-white/16 disabled:pointer-events-none disabled:opacity-25 sm:left-2 sm:h-12 sm:w-12"
              >
                ‹
              </button>
              <button
                type="button"
                aria-label="Next photo"
                disabled={!canNext}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  setLightboxIndex((i) =>
                    i !== null && i < photos.length - 1 ? i + 1 : i,
                  );
                }}
                className="absolute right-1 top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-white/20 bg-white/10 text-lg text-white/90 backdrop-blur-sm transition hover:bg-white/16 disabled:pointer-events-none disabled:opacity-25 sm:right-2 sm:h-12 sm:w-12"
              >
                ›
              </button>
            </>
          ) : null}
          <div
            className="flex max-h-[min(88dvh,920px)] max-w-[min(96vw,920px)] items-center justify-center overflow-hidden"
            style={{
              opacity: lbAnim.opacity,
              transform: `translateX(${lbAnim.tx}px)`,
              transition: lbAnim.transition,
              willChange: "transform",
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={lightboxSrc}
              alt=""
              className="max-h-[min(88dvh,920px)] w-auto max-w-[min(96vw,920px)] object-contain select-none"
              draggable={false}
            />
          </div>
        </div>
      </div>,
      document.body,
    );

  return (
    <>
      <div className="flex h-full min-h-0 max-h-full w-full flex-col overflow-hidden rounded-[24px] bg-[linear-gradient(145deg,#1a1526_0%,#241c32_100%)] shadow-[0_28px_80px_rgba(0,0,0,0.36)] sm:rounded-[28px]">
        <div className="relative min-h-0 flex-1 basis-0 overflow-hidden bg-[linear-gradient(180deg,#262032_0%,#151119_100%)]">
          {onHideForever ? (
            <div className="absolute right-2 top-2 z-20">
              <button
                type="button"
                aria-label="More options"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  setMenuOpen((v) => !v);
                }}
                className="grid h-9 w-9 place-items-center rounded-full border border-white/20 bg-black/35 text-lg text-white/90 backdrop-blur-sm transition hover:bg-black/50"
              >
                ...
              </button>
              {menuOpen ? (
                <button
                  type="button"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    setMenuOpen(false);
                    void onHideForever(restaurant);
                  }}
                  className="absolute right-0 mt-2 whitespace-nowrap rounded-xl border border-rose-400/30 bg-[#2a1218]/95 px-3 py-2 text-xs font-semibold text-rose-100 shadow-lg"
                >
                  Delete forever
                </button>
              ) : null}
            </div>
          ) : null}
          {photos[0] ? (
            <button
              type="button"
              aria-label="View photos"
              onPointerDown={(event) => {
                heroTapRef.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
              }}
              onPointerUp={(event) => {
                const tap = heroTapRef.current;
                heroTapRef.current = null;
                if (!tap || tap.pointerId !== event.pointerId) return;
                const moved = Math.hypot(event.clientX - tap.x, event.clientY - tap.y);
                if (moved < 16) {
                  setLightboxIndex(0);
                }
              }}
              onPointerCancel={() => {
                heroTapRef.current = null;
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setLightboxIndex(0);
                }
              }}
              className="block h-full min-h-0 w-full cursor-grab touch-manipulation p-0 text-left focus:outline-none active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-orange-300/70"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={photos[0]}
                alt=""
                width={800}
                height={600}
                sizes="(max-width: 480px) 92vw, 432px"
                className="pointer-events-none h-full min-h-0 w-full object-cover"
                decoding="async"
                fetchPriority={heroImagePriority}
                loading={heroImagePriority === "high" ? "eager" : "lazy"}
              />
            </button>
          ) : (
            <div className="flex h-full min-h-[8rem] items-center justify-center text-sm text-white/40">No image</div>
          )}
        </div>

        <div className="shrink-0 space-y-2 overflow-hidden px-3 pb-3 pt-2 sm:px-4 sm:pb-4 sm:pt-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[10px] uppercase tracking-[0.28em] text-white/38">Restaurant</p>
              <h3 className="mt-1 text-lg font-semibold leading-snug text-white sm:text-xl">{restaurant.name}</h3>
            </div>
            <div className="shrink-0 rounded-2xl bg-white/8 px-2.5 py-1.5 text-right">
              <p className="text-base font-semibold text-white">{restaurant.rating?.toFixed(1) ?? "—"}</p>
              <p className="text-[10px] text-white/45">{restaurant.userRatingCount ?? 0} reviews</p>
            </div>
          </div>

          <p className="line-clamp-2 text-xs leading-relaxed text-white/55">{restaurant.address}</p>

          {restaurant.categoryIds.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {restaurant.categoryIds.map((cid) => {
                const cat = categories.find((c) => c.id === cid);
                if (!cat) return null;
                return (
                  <span
                    key={cid}
                    className="inline-flex items-center gap-0.5 rounded-full border border-emerald-400/20 bg-emerald-400/8 px-2 py-0.5 text-[10px] font-medium text-emerald-100/90"
                  >
                    <span className="leading-none">{cat.emoji}</span>
                    {cat.title}
                  </span>
                );
              })}
            </div>
          ) : null}

          <div className="flex flex-wrap gap-1.5 text-[10px] text-white/70">
            <span className="rounded-full border border-white/10 bg-white/6 px-2 py-1">
              {restaurant.priceLevel ?? "Price unknown"}
            </span>
            <span className="rounded-full border border-white/10 bg-white/6 px-2 py-1">
              {restaurant.primaryType ?? "Restaurant"}
            </span>
          </div>

          {extraPhotos.length > 0 ? (
            <div className="flex gap-1.5 overflow-x-auto pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {extraPhotos.map((src, thumbIndex) => (
                <button
                  key={src}
                  type="button"
                  onClick={() => setLightboxIndex(thumbIndex + 1)}
                  className="relative h-12 w-12 shrink-0 overflow-hidden rounded-lg ring-1 ring-white/20 transition hover:ring-white/45 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-300/70 sm:h-14 sm:w-14"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={placePhotoWithSize(src, 240, 240)}
                    alt=""
                    width={240}
                    height={240}
                    className="h-full w-full object-cover"
                    loading="lazy"
                    decoding="async"
                  />
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      {lightbox}
    </>
  );
},
(prev, next) =>
  prev.restaurant.id === next.restaurant.id &&
  prev.heroImagePriority === next.heroImagePriority &&
  prev.restaurant.categoryIds.join(",") === next.restaurant.categoryIds.join(",") &&
  prev.onHideForever === next.onHideForever);

const finalResultDetailOpenButtonClass =
  "w-full rounded-full bg-[linear-gradient(135deg,#ff7a18_0%,#ff4d8d_54%,#6a5cff_100%)] px-4 py-2.5 text-xs font-semibold text-white shadow-[0_18px_55px_rgba(255,92,124,0.24)] transition hover:brightness-[1.04] active:scale-[0.98]";

const FinalResultPlaceCard = memo(function FinalResultPlaceCardInner({
  restaurant,
  likedByLine,
  countryCode,
  city,
}: {
  restaurant: CityRestaurant;
  likedByLine?: string;
  countryCode: string;
  city: string;
}) {
  const [detailOpen, setDetailOpen] = useState(false);
  const photos = restaurant.photoUrls ?? [];
  const heroSrc = photos[0] ? placePhotoWithSize(photos[0], 960, 720) : null;

  useEffect(() => {
    if (!detailOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDetailOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [detailOpen]);

  const detailModal =
    detailOpen &&
    createPortal(
      <div
        className="fixed inset-0 z-[260] flex flex-col bg-black/88 p-3 backdrop-blur-sm sm:p-5"
        role="dialog"
        aria-modal="true"
        aria-label={`${restaurant.name} details`}
        onClick={() => setDetailOpen(false)}
      >
        <div
          className="mx-auto mt-10 flex max-h-[min(92dvh,820px)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-white/12 bg-[#1c1624] shadow-2xl sm:mt-12"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
            <p className="min-w-0 truncate pr-2 text-sm font-semibold text-white">{restaurant.name}</p>
            <button
              type="button"
              onClick={() => setDetailOpen(false)}
              className="shrink-0 rounded-full border border-white/14 bg-white/8 px-3 py-1.5 text-xs font-semibold text-white/90 transition hover:bg-white/14"
            >
              Close
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5 pt-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-white/55">
              <span className="rounded-full bg-white/8 px-2 py-1">{restaurant.rating?.toFixed(1) ?? "—"} rating</span>
              <span className="rounded-full bg-white/8 px-2 py-1">{restaurant.userRatingCount ?? 0} reviews</span>
              <span className="rounded-full bg-white/8 px-2 py-1">{restaurant.priceLevel ?? "Price"}</span>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-white/80">{restaurant.address}</p>
            {likedByLine ? (
              <p className="mt-2 text-xs font-medium text-emerald-200/90">{likedByLine}</p>
            ) : null}
            <div className="mt-4">
              <DeliveryOrderLinks restaurant={restaurant} countryCode={countryCode} city={city} />
            </div>
            {photos.length > 0 ? (
              <div className="mt-4 space-y-2">
                <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-white/40">Photos</p>
                <div className="grid grid-cols-2 gap-2">
                  {photos.map((src, i) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={`${restaurant.id}-ph-${i}`}
                      src={placePhotoWithSize(src, 640, 480)}
                      alt=""
                      width={640}
                      height={480}
                      className="aspect-[4/3] w-full rounded-xl object-cover ring-1 ring-white/15"
                      loading="lazy"
                    />
                  ))}
                </div>
              </div>
            ) : (
              <p className="mt-4 text-xs text-white/45">No photos available.</p>
            )}
          </div>
        </div>
      </div>,
      document.body,
    );

  return (
    <>
      <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.06] shadow-[0_12px_40px_rgba(0,0,0,0.25)]">
        <div className="relative aspect-[16/10] w-full bg-[#231a28]">
          {heroSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={heroSrc}
              alt=""
              width={960}
              height={600}
              className="h-full w-full object-cover"
              loading="lazy"
              decoding="async"
            />
          ) : (
            <div className="flex h-full min-h-[140px] items-center justify-center text-sm text-white/40">No image</div>
          )}
        </div>
        <div className="space-y-2 px-4 py-3 sm:py-4">
          <div className="flex items-start justify-between gap-2">
            <h3 className="min-w-0 text-base font-semibold leading-snug text-white sm:text-lg">{restaurant.name}</h3>
            <div className="shrink-0 rounded-xl bg-white/8 px-2 py-1 text-right">
              <p className="text-sm font-semibold text-white">{restaurant.rating?.toFixed(1) ?? "—"}</p>
              <p className="text-[10px] text-white/45">{restaurant.userRatingCount ?? 0} reviews</p>
            </div>
          </div>
          {likedByLine ? <p className="text-xs font-medium text-emerald-200/90">{likedByLine}</p> : null}
          <p className="line-clamp-2 text-xs leading-relaxed text-white/55">{restaurant.address}</p>
          <button type="button" onClick={() => setDetailOpen(true)} className={finalResultDetailOpenButtonClass}>
            View detail
          </button>
        </div>
      </div>
      {detailModal}
    </>
  );
});

function roomStageFlowLabel(stage: RoomStage) {
  switch (stage) {
    case "waiting_categories":
      return "wait · categories";
    case "category_match":
      return "match · categories";
    default:
      return stage;
  }
}

function RoomScreen({
  room,
  isRoomHost,
  stage,
  roomMembers,
  expectedRestaurantMemberCount,
  sharedMatchCategories,
  restaurantFocusCategories,
  membersStillSwipingCategories,
  membersStillSwipingRestaurants,
  allMembersFinishedRestaurants,
  pendingCategories,
  pendingRestaurants,
  mutualFinalRestaurants,
  partialCoLikedFinalRows,
  soloLikedFinalRows,
  restaurantsLoading,
  loadedPlaceCount,
  swipePickLabel,
  myCategoryVotes,
  onStart,
  onStartRestaurantRound,
  onCategoryBatchSubmit,
  onRestaurantDecision,
  onShowFinalResults,
  onRestartCategories,
  onRestartRestaurants,
  onHideRestaurantForever,
  onRetryPlaces,
  onBack,
}: {
  room: RoomRecord | null;
  isRoomHost: boolean;
  stage: RoomStage;
  roomMembers: RoomMember[];
  expectedRestaurantMemberCount: number;
  sharedMatchCategories: Category[];
  restaurantFocusCategories: Category[];
  membersStillSwipingCategories: RoomMember[];
  membersStillSwipingRestaurants: RoomMember[];
  allMembersFinishedRestaurants: boolean;
  pendingCategories: typeof categories;
  pendingRestaurants: CityRestaurant[];
  mutualFinalRestaurants: CityRestaurant[];
  partialCoLikedFinalRows: { restaurant: CityRestaurant; likedByLabel: string }[];
  soloLikedFinalRows: { restaurant: CityRestaurant; likedByLabel: string }[];
  restaurantsLoading: boolean;
  loadedPlaceCount: number;
  swipePickLabel: string;
  myCategoryVotes: RoomCategoryVote[];
  onStart: () => void;
  onStartRestaurantRound: () => void;
  onCategoryBatchSubmit: (likeIds: readonly string[]) => Promise<void>;
  onRestaurantDecision: (restaurantId: string, decision: "like" | "skip") => void | Promise<void>;
  onShowFinalResults: () => void;
  onRestartCategories: () => void | Promise<void>;
  onRestartRestaurants: () => void | Promise<void>;
  onHideRestaurantForever?: (restaurant: CityRestaurant) => void | Promise<void>;
  onRetryPlaces: () => void;
  onBack: () => void;
}) {
  const currentRestaurant = pendingRestaurants[0] ?? null;
  const nextRestaurant = pendingRestaurants[1] ?? null;
  const expectedMembers = Math.max(1, expectedRestaurantMemberCount || roomMembers.length || 1);
  const stillWaitingCount = Math.max(0, membersStillSwipingRestaurants.length);

  const [enterSwipe, setEnterSwipe] = useState(false);
  const [draftLikeIds, setDraftLikeIds] = useState<Set<string>>(() => new Set());
  const [categoryBatchSubmitting, setCategoryBatchSubmitting] = useState(false);
  const categoryDraftSeededRef = useRef(false);

  useEffect(() => {
    if (stage !== "categories") {
      categoryDraftSeededRef.current = false;
    }
  }, [stage]);

  useLayoutEffect(() => {
    if (stage !== "categories" || categoryDraftSeededRef.current) return;
    categoryDraftSeededRef.current = true;
    setDraftLikeIds(new Set(myCategoryVotes.filter((v) => v.decision === "like").map((v) => v.category_id)));
  }, [stage, myCategoryVotes]);

  const handleStartClick = () => {
    if (!isRoomHost) return;
    setEnterSwipe(true);
    window.setTimeout(() => {
      onStart();
      setEnterSwipe(false);
    }, 520);
  };

  const showLobbyChrome = stage === "lobby" && !enterSwipe;
  const showStartTransition = stage === "lobby" && enterSwipe;
  const immersive = stage !== "lobby";

  const swipeStages = (
    <>
      {stage === "waiting_categories" ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-3 text-center">
          <p className="text-xs font-medium uppercase tracking-[0.28em] text-white/40">Categories</p>
          <h2 className="text-2xl font-semibold text-white">Wait for others</h2>
          <p className="max-w-[300px] text-sm leading-6 text-white/58">Everyone finishes category swipes before the room moves on.</p>
          {membersStillSwipingCategories.length > 0 ? (
            <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-white/6 px-4 py-3 text-left">
              <p className="text-xs uppercase tracking-wide text-white/38">Still swiping</p>
              <ul className="mt-2 space-y-1.5 text-sm text-white/85">
                {membersStillSwipingCategories.map((member) => (
                  <li key={roomMemberKey(member)}>{member.name}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {stage === "category_match" ? (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1 pb-2">
          <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/8 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-emerald-100/80">Next step</p>
            <h2 className="mt-2 text-xl font-semibold text-white">
              {sharedMatchCategories.length > 0 ? "Styles you both picked" : "Categories for this round"}
            </h2>
            <p className="mt-2 text-sm leading-6 text-white/58">
              {sharedMatchCategories.length > 0
                ? "Mutual likes — host starts restaurants when ready."
                : "No mutual likes — we blend everyone’s likes for the deck. Host can still start restaurants."}
            </p>
          </div>
          {sharedMatchCategories.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {sharedMatchCategories.map((cat) => (
                <span
                  key={cat.id}
                  className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/15 px-3 py-1.5 text-sm text-white/90"
                >
                  <span>{cat.emoji}</span>
                  {cat.title}
                </span>
              ))}
            </div>
          ) : null}
          {restaurantFocusCategories.length > 0 && sharedMatchCategories.length === 0 ? (
            <div className="space-y-2">
              <p className="text-xs uppercase tracking-wide text-white/40">Deck preview (combined likes)</p>
              <div className="flex flex-wrap gap-2">
                {restaurantFocusCategories.map((cat) => (
                  <span
                    key={cat.id}
                    className="inline-flex items-center gap-1 rounded-full border border-white/12 bg-white/8 px-3 py-1.5 text-sm text-white/90"
                  >
                    <span>{cat.emoji}</span>
                    {cat.title}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          {restaurantFocusCategories.length === 0 && sharedMatchCategories.length === 0 ? (
            <p className="text-sm text-white/50">We’ll suggest a wide mix for your city.</p>
          ) : null}
          {isRoomHost ? (
            <button type="button" onClick={onStartRestaurantRound} className={primaryButtonClass}>
              Start — restaurants
            </button>
          ) : (
            <p className="text-center text-sm text-white/50">Waiting for host to start restaurants.</p>
          )}
        </div>
      ) : null}

      {stage === "categories" ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
          <p className="shrink-0 text-sm leading-snug text-white/70">Like styles for this city. Uncheck = pass. Saved stays locked.</p>

          <div className="grid min-h-0 flex-1 grid-cols-2 content-start gap-2 overflow-y-auto overscroll-contain sm:gap-2.5">
            {categories.map((cat) => {
              const mine = myCategoryVotes.find((v) => v.category_id === cat.id);
              const locked = Boolean(mine);
              const checked = locked ? mine!.decision === "like" : draftLikeIds.has(cat.id);
              return (
                <label
                  key={cat.id}
                  className={`flex min-h-[3.35rem] cursor-pointer items-center gap-2 rounded-2xl border border-white/12 bg-white/[0.06] px-2.5 py-2 transition hover:bg-white/[0.1] active:scale-[0.98] sm:min-h-[3.5rem] sm:gap-2.5 sm:px-3 sm:py-2.5 ${
                    locked ? "cursor-default opacity-[0.78]" : ""
                  }`}
                >
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-white/14 bg-white/[0.08] text-[22px] leading-none sm:h-10 sm:w-10 sm:text-2xl">
                    {cat.emoji}
                  </span>
                  <span className="min-w-0 flex-1 text-[13px] font-semibold leading-snug text-white/92 sm:text-sm">
                    {cat.title}
                  </span>
                  <span className="relative grid h-7 w-7 shrink-0 place-items-center">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={locked}
                      onChange={() => {
                        if (locked) return;
                        setDraftLikeIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(cat.id)) next.delete(cat.id);
                          else next.add(cat.id);
                          return next;
                        });
                      }}
                      className="peer absolute inset-0 z-10 cursor-pointer opacity-0 disabled:cursor-default"
                    />
                    <span
                      className={`pointer-events-none grid h-5 w-5 place-items-center rounded-md border ${
                        checked ? "border-orange-300/55 bg-orange-400/30" : "border-white/22 bg-white/[0.06]"
                      }`}
                    >
                      {checked ? (
                        <svg viewBox="0 0 12 12" className="h-3 w-3 text-white" fill="none" aria-hidden>
                          <path
                            d="M2 6l3 3 5-6"
                            stroke="currentColor"
                            strokeWidth="1.7"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      ) : null}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>

          <button
            type="button"
            disabled={categoryBatchSubmitting}
            onClick={async () => {
              setCategoryBatchSubmitting(true);
              try {
                await onCategoryBatchSubmit(Array.from(draftLikeIds));
              } finally {
                setCategoryBatchSubmitting(false);
              }
            }}
            className={`${primaryButtonClass} shrink-0 text-base`}
          >
            {categoryBatchSubmitting ? "Saving…" : pendingCategories.length > 0 ? "Save & next" : "Continue"}
          </button>
        </div>
      ) : null}

      {stage === "restaurants" ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-hidden">
          {restaurantFocusCategories.length > 0 ? (
            <div className="shrink-0 rounded-xl border border-white/10 bg-white/6 px-3 py-2">
              <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-white/40">Matching on</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {restaurantFocusCategories.map((cat) => (
                  <span
                    key={cat.id}
                    className="inline-flex items-center gap-0.5 rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-medium text-white/88"
                  >
                    <span>{cat.emoji}</span>
                    {cat.title}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          <div className="flex shrink-0 items-center justify-end text-[10px] tabular-nums text-white/40">
            {pendingRestaurants.length} left
          </div>
          <p className="text-[11px] text-white/50">
            Room participants: {expectedMembers} · waiting for {stillWaitingCount}
          </p>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {restaurantsLoading ? (
              <div className="rounded-2xl bg-white/6 px-3 py-2 text-center text-[11px] text-white/50">
                Loading {room?.city}…
              </div>
            ) : loadedPlaceCount === 0 ? (
              <div className="rounded-2xl border border-amber-400/20 bg-amber-400/8 p-4 text-center">
                <p className="text-sm font-medium text-white/88">No places loaded for {room?.city}</p>
                <p className="mt-2 text-xs leading-relaxed text-white/55">Check Maps API key or try again.</p>
                <button type="button" onClick={onRetryPlaces} className={`${primaryButtonCompactClass} mt-4`}>
                  Retry
                </button>
              </div>
            ) : currentRestaurant ? (
              <SwipePanel
                fillHeight
                item={currentRestaurant}
                nextItem={nextRestaurant}
                likeLabel="Like"
                skipLabel="Pass"
                onLike={(place) => onRestaurantDecision(place.id, "like")}
                onSkip={(place) => onRestaurantDecision(place.id, "skip")}
                renderCard={(restaurant) => (
                  <RestaurantSwipeCard
                    restaurant={restaurant}
                    heroImagePriority="high"
                    onHideForever={onHideRestaurantForever}
                  />
                )}
              />
            ) : (
              <div className="rounded-2xl bg-white/6 p-3 text-center">
                {allMembersFinishedRestaurants ? (
                  <>
                    <p className="text-xs font-medium text-white/80">Everyone finished restaurant picks.</p>
                    {isRoomHost ? (
                      <button
                        type="button"
                        onClick={onShowFinalResults}
                        className={`${primaryButtonCompactClass} mt-3`}
                      >
                        Show result
                      </button>
                    ) : (
                      <p className="mt-2 text-xs leading-6 text-white/58">Waiting for host to show results.</p>
                    )}
                  </>
                ) : (
                  <>
                    <p className="text-xs font-medium text-white/80">You are done. Waiting for others.</p>
                    <p className="mt-1 text-[11px] text-white/50">
                      Waiting for {stillWaitingCount} of {expectedMembers} participants.
                    </p>
                    {membersStillSwipingRestaurants.length > 0 ? (
                      <div className="mx-auto mt-2 w-full max-w-sm rounded-2xl border border-white/10 bg-white/6 px-4 py-3 text-left">
                        <p className="text-xs uppercase tracking-wide text-white/38">Still choosing restaurants</p>
                        <ul className="mt-2 space-y-1.5 text-sm text-white/85">
                          {membersStillSwipingRestaurants.map((member) => (
                            <li key={roomMemberKey(member)}>{member.name}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      ) : null}

      {stage === "final" ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-0.5 pb-2">
            <div className="space-y-4">
              <div className={`sticky top-0 z-10 -mx-0.5 mb-1 flex items-center gap-2 px-1 py-2 ${uiStickyBar}`}>
                <button
                  type="button"
                  onClick={onBack}
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-white/12 bg-white/8 text-white/90 transition hover:bg-white/14"
                  aria-label="Back to home"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden>
                    <path
                      d="M15 18l-6-6 6-6"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-white">Final picks</p>
                  <p className="text-[10px] text-white/45">← leaves the room</p>
                </div>
              </div>

              <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/10 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-100/80">Top matches</p>
                <h2 className="mt-1 text-lg font-semibold text-white">Liked by everyone</h2>
                <p className="mt-2 text-sm leading-6 text-white/58">Everyone liked these. Open a card for address and photos.</p>
              </div>
              <div className="space-y-3">
                {mutualFinalRestaurants.length > 0 ? (
                  mutualFinalRestaurants.map((restaurant) => (
                    <FinalResultPlaceCard
                      key={`mutual-${restaurant.id}`}
                      restaurant={restaurant}
                      countryCode={room?.country_code ?? "US"}
                      city={room?.city ?? ""}
                    />
                  ))
                ) : (
                  <div className="rounded-2xl bg-white/6 p-4 text-sm leading-6 text-white/58">
                    No restaurant was liked by everyone in this round.
                  </div>
                )}
              </div>

              {partialCoLikedFinalRows.length > 0 ? (
                <div className="space-y-3 pt-2">
                  <div className="rounded-2xl border border-white/12 bg-white/6 p-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/45">Co-likes</p>
                    <h2 className="mt-1 text-lg font-semibold text-white">Liked by some of you</h2>
                    <p className="mt-2 text-sm leading-6 text-white/55">Two or more liked — not everyone. Names show who.</p>
                  </div>
                  {partialCoLikedFinalRows.map(({ restaurant, likedByLabel }) => (
                    <FinalResultPlaceCard
                      key={`partial-${restaurant.id}`}
                      restaurant={restaurant}
                      likedByLine={`Liked by ${likedByLabel}`}
                      countryCode={room?.country_code ?? "US"}
                      city={room?.city ?? ""}
                    />
                  ))}
                </div>
              ) : null}

              {soloLikedFinalRows.length > 0 ? (
                <div className="space-y-3 pt-2">
                  <div className="rounded-2xl border border-white/12 bg-white/6 p-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/45">Solo likes</p>
                    <h2 className="mt-1 text-lg font-semibold text-white">Only one person</h2>
                    <p className="mt-2 text-sm leading-6 text-white/55">Still shown so nothing gets lost.</p>
                  </div>
                  {soloLikedFinalRows.map(({ restaurant, likedByLabel }) => (
                    <FinalResultPlaceCard
                      key={`solo-${restaurant.id}`}
                      restaurant={restaurant}
                      likedByLine={`Only ${likedByLabel}`}
                      countryCode={room?.country_code ?? "US"}
                      city={room?.city ?? ""}
                    />
                  ))}
                </div>
              ) : null}

              {mutualFinalRestaurants.length === 0 &&
              partialCoLikedFinalRows.length === 0 &&
              soloLikedFinalRows.length === 0 ? (
                <div className="rounded-2xl bg-white/6 p-4 text-sm leading-6 text-white/58">
                  No likes this round, or details didn’t load.
                  {isRoomHost ? " Host can restart categories or restaurants." : ""}
                </div>
              ) : null}

              {mutualFinalRestaurants.length === 0 &&
              partialCoLikedFinalRows.length === 0 &&
              soloLikedFinalRows.length === 0 &&
              isRoomHost ? (
                <>
                  <button type="button" onClick={onRestartCategories} className={primaryButtonClass}>
                    Choose food category again
                  </button>
                  <button type="button" onClick={onRestartRestaurants} className={ghostButtonClass}>
                    Choose restaurants again
                  </button>
                </>
              ) : null}

              <button type="button" onClick={onBack} className={ghostButtonClass}>
                Done — back to home
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {showLobbyChrome ? (
        <div className="flex min-h-0 flex-1 flex-col gap-5">
          <div className="flex items-center justify-between">
            <button onClick={onBack} className={ghostButtonClass}>
              Back
            </button>
            <span className="rounded-full border border-white/10 bg-white/6 px-4 py-2 text-xs uppercase tracking-[0.24em] text-white/70">
              {isRoomHost ? "Host mode" : "Joined"}
            </span>
          </div>

          <div className="rounded-[24px] bg-[linear-gradient(135deg,#ff7a18_0%,#ff4d8d_54%,#6a5cff_100%)] p-[1px]">
            <div className={`rounded-[23px] px-4 py-3 ${uiInset}`}>
              <p className="text-xs text-white/55">{isRoomHost ? "Your room is live" : "You are inside the room"}</p>
              <h1 className="mt-1.5 text-3xl font-semibold tracking-[0.14em] text-white">{room?.code}</h1>
              <p className="mt-1.5 text-xs text-white/58">
                {room?.city}, {room?.country_code}
              </p>
            </div>
          </div>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
            <div className="rounded-[28px] border border-white/10 bg-white/6 p-4">
              <p className="text-sm text-white/55">People in this room</p>
              <div className="mt-3 space-y-2">
                {roomMembers.length > 0 ? (
                  roomMembers.map((member) => (
                    <div key={member.id} className="flex items-center justify-between rounded-2xl bg-white/6 px-4 py-3">
                      <span className="font-medium text-white">
                        {member.name}
                        {room && member.name === room.host_name ? (
                          <span className="ml-2 text-xs font-normal text-white/45">Host</span>
                        ) : null}
                      </span>
                      <span className="text-xs text-white/45">joined</span>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-white/55">No one has joined yet.</p>
                )}
              </div>
            </div>

            <div className="rounded-[28px] border border-white/10 bg-white/6 p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-white/55">Room flow</p>
                <span className="text-xs uppercase tracking-[0.22em] text-white/45">{roomStageFlowLabel(stage)}</span>
              </div>

              <div className="mt-4 space-y-3">
                <div className="rounded-2xl bg-white/6 px-3 py-3">
                  <p className="text-base font-semibold text-white">
                    {isRoomHost ? "Start when you are ready." : "Waiting for the host"}
                  </p>
                  <p className="mt-1.5 text-sm leading-snug text-white/58">
                    {isRoomHost ? "Start sends everyone to category picks." : "Host starts — you’ll follow automatically."}
                  </p>
                </div>

                {isRoomHost ? (
                  <button type="button" onClick={handleStartClick} className={primaryButtonClass}>
                    Start swiping categories
                  </button>
                ) : (
                  <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-center text-sm text-white/55">
                    Waiting for host to start…
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {showStartTransition ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5">
          <div className="relative flex h-32 w-32 items-center justify-center">
            <div
              className="absolute inset-0 rounded-full border-2 border-orange-400/25"
              style={{ animation: "bitesync-orbit 1.6s ease-in-out infinite" }}
            />
            <div
              className="absolute inset-3 rounded-full border border-white/20"
              style={{ animation: "bitesync-orbit 1.6s ease-in-out infinite 0.2s" }}
            />
            <div
              className="absolute inset-6 rounded-full border border-fuchsia-400/20"
              style={{ animation: "bitesync-orbit 1.6s ease-in-out infinite 0.4s" }}
            />
            <span className="relative text-xs font-medium uppercase tracking-[0.32em] text-white/55">Starting</span>
          </div>
          <p className="text-sm text-white/40">Preparing deck…</p>
        </div>
      ) : null}

      {immersive ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden overscroll-none pt-1">
          {stage === "waiting_categories" || stage === "category_match" ? (
            <div className="flex shrink-0 items-center justify-between gap-2 px-1 pb-2">
              <button type="button" onClick={onBack} className={ghostButtonClass}>
                Leave room
              </button>
              <span className="text-[11px] text-white/40">{room?.code}</span>
            </div>
          ) : null}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden pb-2">{swipeStages}</div>
          {stage === "categories" && (swipePickLabel || draftLikeIds.size > 0) ? (
            <div className="shrink-0 max-h-11 overflow-hidden border-t border-white/10 bg-[#151119]/95 px-2 py-1">
              {draftLikeIds.size > 0 ? (
                <p
                  className="truncate text-[10px] leading-tight text-white/55"
                  title={[...draftLikeIds]
                    .map((id) => categories.find((c) => c.id === id))
                    .filter(Boolean)
                    .map((c) => `${c!.emoji} ${c!.title}`)
                    .join(" · ")}
                >
                  <span className="text-white/35">Likes:</span>{" "}
                  {[...draftLikeIds]
                    .map((id) => categories.find((c) => c.id === id))
                    .filter(Boolean)
                    .map((c) => `${c!.emoji}${c!.title}`)
                    .join(" · ")}
                </p>
              ) : null}
              {swipePickLabel ? (
                <p
                  className={`truncate text-[10px] leading-tight text-white/70 ${draftLikeIds.size > 0 ? "mt-0.5" : ""}`}
                  title={swipePickLabel}
                >
                  <span className="text-white/35">Last:</span> {swipePickLabel}
                </p>
              ) : null}
            </div>
          ) : null}
          {stage === "restaurants" ? (
            <div className="flex min-h-[2.5rem] shrink-0 flex-col justify-center border-t border-white/10 bg-[#151119]/95 px-2 py-1">
              {swipePickLabel ? (
                <p className="truncate text-[10px] leading-tight text-white/70" title={swipePickLabel}>
                  <span className="text-white/35">Last:</span> {swipePickLabel}
                </p>
              ) : (
                <p className="text-[10px] leading-tight text-transparent" aria-hidden>
                  &nbsp;
                </p>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function swipeItemStableKey(item: unknown): string {
  if (item && typeof item === "object" && "id" in item) {
    const id = (item as { id: unknown }).id;
    if (typeof id === "string" || typeof id === "number") return String(id);
  }
  return "";
}

function SwipePanel<T>({
  item,
  nextItem,
  likeLabel,
  skipLabel,
  onLike,
  onSkip,
  renderCard,
  fillHeight = false,
}: {
  item: T;
  nextItem: T | null;
  likeLabel: string;
  skipLabel: string;
  onLike: (item: T) => void | Promise<void>;
  onSkip: (item: T) => void | Promise<void>;
  renderCard: (item: T) => React.ReactNode;
  fillHeight?: boolean;
}) {
  const [dragX, setDragX] = useState(0);
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const gestureItemRef = useRef<T | null>(null);
  const dragCommittedRef = useRef(false);
  const commitBusyRef = useRef(false);
  const activePointerIdRef = useRef<number | null>(null);
  const dragXRef = useRef(0);
  dragXRef.current = dragX;

  const swipeLayerRef = useRef<HTMLDivElement | null>(null);
  const detachWindowListenersRef = useRef<(() => void) | null>(null);

  const itemKey = swipeItemStableKey(item);

  const reset = useCallback(() => {
    detachWindowListenersRef.current?.();
    detachWindowListenersRef.current = null;
    activePointerIdRef.current = null;
    dragCommittedRef.current = false;
    gestureItemRef.current = null;
    setDragX(0);
  }, []);

  useLayoutEffect(() => {
    reset();
  }, [itemKey, reset]);

  useEffect(() => {
    return () => {
      detachWindowListenersRef.current?.();
      detachWindowListenersRef.current = null;
    };
  }, []);

  const commit = useCallback(
    (direction: "like" | "skip") => {
      const target = gestureItemRef.current;
      if (!target) return;
      commitBusyRef.current = true;
      setDragX(direction === "like" ? 560 : -560);
      window.setTimeout(() => {
        void (async () => {
          try {
            if (direction === "like") {
              await Promise.resolve(onLike(target));
            } else {
              await Promise.resolve(onSkip(target));
            }
          } catch {
            reset();
            return;
          } finally {
            commitBusyRef.current = false;
            gestureItemRef.current = null;
          }
        })();
      }, 85);
    },
    [onLike, onSkip, reset],
  );

  const handlePointerDownCapture = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (commitBusyRef.current) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      if (!event.currentTarget.contains(event.target as Node)) return;

      detachWindowListenersRef.current?.();

      gestureItemRef.current = item;
      startXRef.current = event.clientX;
      startYRef.current = event.clientY;
      activePointerIdRef.current = event.pointerId;
      dragCommittedRef.current = false;

      const pointerId = event.pointerId;

      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId || activePointerIdRef.current !== pointerId) return;
        const dx = ev.clientX - startXRef.current;
        const dy = ev.clientY - startYRef.current;

        if (!dragCommittedRef.current) {
          if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
          if (Math.abs(dx) < Math.abs(dy) - 4) return;
          dragCommittedRef.current = true;
          try {
            swipeLayerRef.current?.setPointerCapture(ev.pointerId);
          } catch {
            /* ignore */
          }
        }

        setDragX(dx);
        ev.preventDefault();
      };

      const onUpOrCancel = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId || activePointerIdRef.current !== pointerId) return;
        activePointerIdRef.current = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUpOrCancel);
        window.removeEventListener("pointercancel", onUpOrCancel);
        detachWindowListenersRef.current = null;

        try {
          swipeLayerRef.current?.releasePointerCapture(ev.pointerId);
        } catch {
          /* ignore */
        }

        if (!dragCommittedRef.current) {
          gestureItemRef.current = null;
          return;
        }

        const x = ev.clientX - startXRef.current;
        if (x > 90) {
          void commit("like");
          return;
        }
        if (x < -90) {
          void commit("skip");
          return;
        }
        gestureItemRef.current = null;
        dragCommittedRef.current = false;
        setDragX(0);
      };

      detachWindowListenersRef.current = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUpOrCancel);
        window.removeEventListener("pointercancel", onUpOrCancel);
        detachWindowListenersRef.current = null;
      };

      window.addEventListener("pointermove", onMove, { passive: false });
      window.addEventListener("pointerup", onUpOrCancel);
      window.addEventListener("pointercancel", onUpOrCancel);
    },
    [item, commit],
  );

  const triggerAction = useCallback(
    (direction: "like" | "skip") => {
      if (commitBusyRef.current) return;
      gestureItemRef.current = item;
      void commit(direction);
    },
    [item, commit],
  );

  const swipeTintMode = dragX > 10 ? "like" : dragX < -10 ? "pass" : "none";
  const swipeTintStrength = swipeTintMode === "none" ? 0 : Math.min(1, Math.abs(dragX) / 130);

  return (
    <div className={fillHeight ? "flex min-h-0 flex-1 flex-col" : "space-y-4"}>
      <div
        className={
          fillHeight
            ? `relative flex-1 touch-pan-y select-none overflow-hidden min-h-0 max-h-full ${uiSwipeDeck}`
            : `relative h-[min(420px,58dvh)] min-h-[min(380px,52dvh)] touch-pan-y select-none sm:h-[460px] ${uiSwipeDeck}`
        }
      >
        {nextItem ? (
          <div
            className={
              fillHeight
                ? "pointer-events-none absolute inset-0 z-0 overflow-hidden rounded-[28px] px-0.5 sm:px-1"
                : "pointer-events-none absolute inset-0 z-0 overflow-hidden rounded-[28px] px-0.5 sm:px-1"
            }
          >
            <div className={fillHeight ? "h-full min-h-0" : "flex h-full min-h-0 items-stretch justify-center"}>
              {renderCard(nextItem)}
            </div>
          </div>
        ) : null}

        <div
          ref={swipeLayerRef}
          onPointerDownCapture={handlePointerDownCapture}
          onPointerCancel={reset}
          className="absolute inset-0 z-10 isolate transform-gpu backface-hidden will-change-transform"
          style={{
            transform: `translate3d(${dragX}px,0,0) rotate(${dragX / 18}deg)`,
            transition: "none",
          }}
        >
          <div className={`relative h-full ${fillHeight ? "min-h-0 px-0.5 sm:px-1" : ""}`}>
            <div
              className={`pointer-events-none absolute left-3 top-3 z-20 rounded-full border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.2em] transition-opacity sm:left-4 sm:top-4 sm:px-4 sm:py-2 sm:text-xs ${
                swipeTintMode === "like"
                  ? "border-emerald-300/70 bg-emerald-400/30 text-emerald-50"
                  : swipeTintMode === "pass"
                    ? "border-rose-300/70 bg-rose-400/30 text-rose-50"
                    : "border-white/15 bg-white/8 text-white/70"
              } ${Math.abs(dragX) > 12 ? "opacity-100" : "opacity-0"}`}
            >
              {swipeTintMode === "like" ? likeLabel : swipeTintMode === "pass" ? skipLabel : likeLabel}
            </div>
            <div className="relative z-[1] h-full min-h-0 flex flex-col">
              {renderCard(item)}
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 z-[12] rounded-[24px] sm:rounded-[28px]"
                style={{
                  opacity: swipeTintStrength,
                  background:
                    swipeTintMode === "like"
                      ? "linear-gradient(160deg, rgba(52,211,153,0.42) 0%, rgba(16,185,129,0.14) 55%, rgba(5,150,105,0.08) 100%)"
                      : swipeTintMode === "pass"
                        ? "linear-gradient(160deg, rgba(251,113,133,0.45) 0%, rgba(248,113,113,0.16) 55%, rgba(185,28,28,0.1) 100%)"
                        : "transparent",
                  boxShadow:
                    swipeTintMode === "like"
                      ? `inset 0 0 0 3px rgba(52, 211, 153, ${0.35 + swipeTintStrength * 0.45})`
                      : swipeTintMode === "pass"
                        ? `inset 0 0 0 3px rgba(251, 113, 133, ${0.35 + swipeTintStrength * 0.45})`
                        : "none",
                }}
              />
            </div>
          </div>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => triggerAction("skip")}
          className="rounded-xl border border-rose-300/45 bg-rose-300/18 px-3 py-2.5 text-sm font-semibold text-rose-100"
        >
          Pass
        </button>
        <button
          type="button"
          onClick={() => triggerAction("like")}
          className="rounded-xl border border-emerald-300/45 bg-emerald-300/18 px-3 py-2.5 text-sm font-semibold text-emerald-100"
        >
          Like
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-2">
      <span className="text-sm font-medium text-white/68">{label}</span>
      {children}
    </label>
  );
}

function getInitials(value: string) {
  return value
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function createRoomCode(city: string) {
  const cityCode = city.replace(/[^a-zA-Z]/g, "").slice(0, 4).toUpperCase() || "BSYN";
  const suffix = Math.floor(100 + Math.random() * 900);
  return `${cityCode} - ${suffix}`;
}

function formatRoomCodeInput(value: string) {
  const cleaned = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const prefix = cleaned.slice(0, 4);
  const suffix = cleaned
    .slice(4)
    .replace(/[^0-9]/g, "")
    .slice(0, 3);
  if (!prefix) return "";
  if (!suffix) return prefix.length >= 4 ? `${prefix} - ` : prefix;
  return `${prefix} - ${suffix}`;
}

function roomCodeCandidates(value: string) {
  const cleaned = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const prefix = cleaned.slice(0, 4);
  const suffix = cleaned
    .slice(4)
    .replace(/[^0-9]/g, "")
    .slice(0, 3);
  if (!prefix) return [] as string[];
  if (!suffix) return [prefix];
  const compact = `${prefix}${suffix}`;
  const dashed = `${prefix} - ${suffix}`;
  return compact === dashed ? [dashed] : [dashed, compact];
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "object" && error !== null) {
    const maybeError = error as ErrorLike;
    if (maybeError.message) {
      return maybeError.message;
    }
  }

  return fallback;
}

function isDuplicateKeyError(error: unknown) {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const maybeError = error as ErrorLike;
  return maybeError.code === "23505" || maybeError.message?.toLowerCase().includes("duplicate key") === true;
}

function isMissingColumnError(error: unknown, columnName: string) {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const maybeError = error as ErrorLike;
  const message = maybeError.message?.toLowerCase() ?? "";
  const normalizedColumn = columnName.toLowerCase();

  return message.includes("schema cache") && message.includes(normalizedColumn);
}

function getSharedLikedIds<T extends { user_id: string | null; decision: "like" | "skip"; member_name?: string }>(
  params: {
    votes: T[];
    itemKey: "category_id" | "restaurant_id";
    memberCount: number;
    fallbackVotes: T[];
  },
) {
  const { votes, itemKey, memberCount, fallbackVotes } = params;

  const likedCounts = new Map<string, Set<string>>();
  for (const vote of votes) {
    const itemId = (vote as T & Record<string, string>)[itemKey];
    let voterKey = "";
    if (vote.user_id) {
      voterKey = String(vote.user_id).trim();
    } else if (typeof vote.member_name === "string" && vote.member_name.trim()) {
      voterKey = normalizedMemberNameKey(vote.member_name);
    }
    if (!itemId || vote.decision !== "like" || !voterKey) continue;
    const users = likedCounts.get(itemId) ?? new Set<string>();
    users.add(voterKey);
    likedCounts.set(itemId, users);
  }

  const shared = Array.from(likedCounts.entries())
    .filter(([, users]) => users.size >= memberCount)
    .map(([itemId]) => itemId);

  if (shared.length > 0) {
    return shared;
  }

  if (memberCount <= 1) {
    return fallbackVotes
      .filter((vote) => vote.decision === "like")
      .map((vote) => (vote as T & Record<string, string>)[itemKey]);
  }

  return [];
}

const fieldClass =
  "w-full rounded-[22px] border border-white/10 bg-white/6 px-4 py-2.5 text-sm text-white outline-none transition focus:border-white/28";

const ghostButtonClass =
  "rounded-full border border-white/10 bg-white/6 px-4 py-2 text-sm font-semibold text-white/80";

const primaryButtonClass =
  "w-full rounded-full bg-[linear-gradient(135deg,#ff7a18_0%,#ff4d8d_54%,#6a5cff_100%)] px-5 py-4 font-semibold text-white shadow-[0_18px_55px_rgba(255,92,124,0.24)]";

const primaryButtonCompactClass =
  "w-full rounded-full bg-[linear-gradient(135deg,#ff7a18_0%,#ff4d8d_54%,#6a5cff_100%)] px-5 py-3.5 text-sm font-semibold text-white shadow-[0_18px_55px_rgba(255,92,124,0.24)]";

const primaryCardClass =
  "w-full rounded-[28px] bg-[linear-gradient(135deg,#ff7a18_0%,#ff4d8d_52%,#8f6bff_100%)] px-5 py-5 text-left shadow-[0_20px_70px_rgba(255,101,101,0.28)]";

const menuItemClass =
  "w-full rounded-xl px-3 py-2 text-left text-sm font-medium text-white/80 transition hover:bg-white/8";
