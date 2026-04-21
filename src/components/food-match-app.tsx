"use client";

import { createPortal } from "react-dom";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AuthChangeEvent, Session, User } from "@supabase/supabase-js";

import { categories, countries, type Category } from "@/data/mock-data";
import { getSupabaseBrowserClient, hasSupabaseEnv, supabaseConfigError } from "@/lib/supabase";

type Screen = "auth" | "home" | "profile" | "room" | "hidden_places";
type AuthMode = "signin" | "signup";
type RoomMode = "host" | "join";
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

type RoomRecord = {
  id: string;
  code: string;
  host_name: string;
  country_code: string;
  city: string;
};

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

type ErrorLike = {
  message?: string;
  code?: string;
};

function categoryVoteKey(vote: RoomCategoryVote): string {
  if (vote.user_id) return vote.user_id;
  if (vote.member_name) return `n:${vote.member_name}`;
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
  return member.user_id ?? `n:${member.name}`;
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
    if (!member.user_id && [...byKey.values()].some((row) => row.name === member.name)) continue;
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
  const [roomMode, setRoomMode] = useState<RoomMode>("host");
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
  const visibleCityRestaurants = useMemo(
    () => (activeRoom ? cityRestaurants : []),
    [activeRoom, cityRestaurants],
  );
  const currentUserId = session?.user.id ?? null;
  const memberCount = useMemo(() => {
    if (visibleRoomMembers.length === 0) return 1;
    const distinctUserIds = new Set(
      visibleRoomMembers.map((m) => m.user_id).filter((id): id is string => Boolean(id)),
    );
    if (distinctUserIds.size >= 2) return distinctUserIds.size;
    const distinctNames = new Set(visibleRoomMembers.map((m) => m.name.trim().toLowerCase()));
    return Math.max(distinctNames.size, 1);
  }, [visibleRoomMembers]);

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

  const categoryDeckSize = categories.length;

  const memberCategoryProgress = useMemo(() => {
    const perVoter = new Map<string, Set<string>>();
    for (const vote of categoryVotes) {
      const key = categoryVoteKey(vote);
      if (!key) continue;
      const set = perVoter.get(key) ?? new Set<string>();
      set.add(vote.category_id);
      perVoter.set(key, set);
    }
    return perVoter;
  }, [categoryVotes]);

  const allMembersFinishedCategories = useMemo(() => {
    if (memberCount <= 1) return true;
    if (visibleRoomMembers.length === 0) return false;
    for (const member of visibleRoomMembers) {
      const set = memberCategoryProgress.get(roomMemberKey(member));
      if (!set || set.size < categoryDeckSize) return false;
    }
    return true;
  }, [memberCount, visibleRoomMembers, memberCategoryProgress, categoryDeckSize]);

  const membersStillSwipingCategories = useMemo(() => {
    if (memberCount <= 1) return [] as RoomMember[];
    return visibleRoomMembers.filter((member) => {
      const set = memberCategoryProgress.get(roomMemberKey(member));
      return !set || set.size < categoryDeckSize;
    });
  }, [memberCount, visibleRoomMembers, memberCategoryProgress, categoryDeckSize]);

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

  const finalRestaurantIds = useMemo(
    () =>
      getSharedLikedIds({
        votes: restaurantVotes,
        itemKey: "restaurant_id",
        memberCount,
        fallbackVotes: myRestaurantVotes,
      }),
    [memberCount, myRestaurantVotes, restaurantVotes],
  );

  const finalRestaurants = useMemo(
    () =>
      restaurantCandidates
        .filter((restaurant) => finalRestaurantIds.includes(restaurant.id))
        .sort((left, right) => (right.rating ?? 0) - (left.rating ?? 0)),
    [finalRestaurantIds, restaurantCandidates],
  );

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
      setRoomMembers([]);
      setSwipePickLabel("");
      setActiveRoom(roomData as RoomRecord);
      syncRoomMembers(profile.full_name);
      setRoomMode("host");
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
      const code = roomCodeInput.trim().toUpperCase();
      const { data: roomData, error: roomError } = await getRoomsTable()
        .select("*")
        .eq("code", code)
        .maybeSingle();

      if (roomError) throw roomError;
      if (!roomData) throw new Error("Room not found.");

      const memberError = await insertRoomMember(roomData.id, profile.full_name, session.user.id);

      if (memberError && !memberError.message?.toLowerCase().includes("duplicate")) {
        throw memberError;
      }

      setRoomStage("lobby");
      setCategoryVotes([]);
      setRestaurantVotes([]);
      setRoomMembers([]);
      setSwipePickLabel("");
      setActiveRoom(roomData as RoomRecord);
      syncRoomMembers(roomData.host_name);
      syncRoomMembers(profile.full_name);
      setRoomMode("join");
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

      const progress = new Map<string, Set<string>>();
      for (const vote of votesSnapshot) {
        const key = categoryVoteKey(vote);
        if (!key) continue;
        const set = progress.get(key) ?? new Set<string>();
        set.add(vote.category_id);
        progress.set(key, set);
      }

      const everyoneDone =
        visibleRoomMembers.length > 0 &&
        visibleRoomMembers.every((member) => {
          const set = progress.get(roomMemberKey(member));
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

      const progress = new Map<string, Set<string>>();
      for (const vote of votesSnapshot) {
        const key = categoryVoteKey(vote);
        if (!key) continue;
        const set = progress.get(key) ?? new Set<string>();
        set.add(vote.category_id);
        progress.set(key, set);
      }

      const everyoneDone =
        visibleRoomMembers.length > 0 &&
        visibleRoomMembers.every((member) => {
          const set = progress.get(roomMemberKey(member));
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
      const myIds = new Set(
        restaurantVotes
          .filter(
            (vote) =>
              vote.user_id === currentUserId ||
              (vote.user_id == null && vote.member_name === profile.full_name),
          )
          .map((v) => v.restaurant_id),
      );
      const remaining = restaurantCandidates.filter((r) => !myIds.has(r.id));
      if (remaining.length === 0) {
        setRoomStage("final");
      }
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

      setRestaurantVotes((prev) => {
        const myIds = new Set(
          prev
            .filter(
              (vote) =>
                vote.user_id === currentUserId ||
                (vote.user_id == null && vote.member_name === profile.full_name),
            )
            .map((v) => v.restaurant_id),
        );
        const remaining = restaurantCandidates.filter((r) => !myIds.has(r.id));
        if (remaining.length === 0) {
          queueMicrotask(() => setRoomStage("final"));
        }
        return prev;
      });
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

    void loadMembers();

    const staggerDelays = [300, 900, 2200];
    const staggerIds = staggerDelays.map((delay) =>
      window.setTimeout(() => {
        void loadMembers();
      }, delay),
    );

    const pollMs = screen === "room" ? 1200 : 3500;
    const pollId = window.setInterval(() => {
      void loadMembers();
    }, pollMs);

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void loadMembers();
      }
    };

    const onWindowFocus = () => {
      void loadMembers();
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
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          void loadMembers();
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

    void loadCategoryVotes();
    void loadRestaurantVotes();

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
      .subscribe();

    return () => {
      active = false;
      if (categoryReloadTimer) clearTimeout(categoryReloadTimer);
      void supabase.removeChannel(categoryChannel);
      void supabase.removeChannel(restaurantChannel);
    };
  }, [activeRoom, supabase]);

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
      <main className="grid h-[100dvh] place-items-center overflow-hidden bg-[#0f0c12] text-white">
        <div className="text-center">
          <p className="text-sm uppercase tracking-[0.28em] text-white/45">BiteSync</p>
          <h1 className="mt-4 text-4xl font-semibold">Loading...</h1>
        </div>
      </main>
    );
  }

  return (
    <main className="h-[100dvh] overflow-hidden bg-[radial-gradient(circle_at_top,_rgba(255,120,68,0.14),_transparent_22%),radial-gradient(circle_at_bottom_right,_rgba(111,66,193,0.12),_transparent_24%),#0f0c12] text-white">
      <div className="mx-auto flex h-full w-full max-w-[460px] flex-col px-3 py-3 sm:px-4 sm:py-4">
        <div className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-[28px] border border-white/10 bg-[#141117]/92 shadow-[0_24px_100px_rgba(0,0,0,0.45)] backdrop-blur-xl">
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
                Add your Supabase keys to Vercel first to enable real sign up, profile saving, and shared rooms.
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
                mode={roomMode}
                stage={roomStage}
                roomMembers={visibleRoomMembers}
                restaurantVotes={restaurantVotes}
                sharedCategoryIds={sharedCategoryIds}
                restaurantFocusCategories={restaurantFocusCategories}
                membersStillSwipingCategories={membersStillSwipingCategories}
                pendingCategories={pendingCategories}
                pendingRestaurants={pendingRestaurants}
                finalRestaurants={finalRestaurants}
                restaurantsLoading={restaurantsLoading}
                loadedPlaceCount={visibleCityRestaurants.length}
                swipePickLabel={swipePickLabel}
                myCategoryVotes={myCategoryVotes}
                onStart={() => setRoomStage("categories")}
                onChangeStage={setRoomStage}
                onStartRestaurantRound={() => setRoomStage("restaurants")}
                onCategoryBatchSubmit={handleCategoryBatchSubmit}
                onRestaurantDecision={handleRestaurantDecision}
                onHideRestaurantForever={hasSupabaseEnv ? hideRestaurantForever : undefined}
                onRetryPlaces={() => setPlacesFetchNonce((n) => n + 1)}
                onBack={() => {
                  setSwipePickLabel("");
                  setScreen("home");
                  setRoomStage("lobby");
                }}
              />
            ) : null}
          </div>

          {undoHidePlace ? (
            <div className="pointer-events-auto absolute inset-x-3 bottom-3 z-[60] flex items-center justify-between gap-3 rounded-2xl border border-white/12 bg-[#1b1720]/95 px-4 py-3 shadow-[0_12px_40px_rgba(0,0,0,0.4)] backdrop-blur-md">
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
    <div className="flex items-center justify-between border-b border-white/8 px-4 py-4">
      <div>
        <p className="text-xs uppercase tracking-[0.26em] text-white/38">BiteSync</p>
        <p className="mt-1 text-sm text-white/68">{subtitle}</p>
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
              <div
                className={`absolute right-0 top-14 z-20 rounded-2xl border border-white/10 bg-[#1b1720] p-2 shadow-[0_18px_60px_rgba(0,0,0,0.35)] ${onOpenHiddenPlaces ? "w-52" : "w-44"}`}
              >
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
          {mode === "signup" ? "Create your BiteSync account." : "Welcome back."}
        </h1>
        <p className={`mt-2 text-sm text-white/58 ${isSignIn ? "leading-5" : "leading-6"}`}>
          {mode === "signup"
            ? "Sign up once, then every time you open the app you can go straight to Host or Join."
            : "Sign in to jump back into your rooms and keep your profile."}
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
        <h1 className="text-2xl font-semibold text-white">Hidden from suggestions</h1>
        <p className="mt-2 text-sm leading-relaxed text-white/60">
          Checked places return to your restaurant deck. Uncheck any you want to stay hidden. Use Select all, then
          uncheck a few to restore only some.
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
            Nothing hidden yet. While swiping, tap &quot;Hide forever&quot; on a card to remove it from suggestions.
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
        {submitting ? "Saving…" : "Restore checked to suggestions"}
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
        <div className="rounded-[27px] bg-[#161218] p-5">
          <p className="text-sm text-white/55">Signed in as</p>
          <h1 className="mt-2 text-3xl font-semibold text-white">{profile?.full_name}</h1>
          <p className="mt-2 text-sm text-white/58">
            {profile?.city}, {profile?.country_code}
          </p>
        </div>
      </div>

      <div className="grid gap-3">
        <button onClick={onHost} disabled={submitting} className={primaryCardClass}>
          <p className="text-sm text-white/68">Start a fresh decision room</p>
          <p className="mt-1 text-2xl font-semibold">Host a room</p>
        </button>

        <div className="rounded-[28px] border border-white/10 bg-white/6 p-4">
          <p className="text-sm text-white/58">Already have a room code?</p>
          <input
            value={roomCodeInput}
            onChange={(event) => onRoomCodeChange(event.target.value.toUpperCase())}
            className={`${fieldClass} mt-4 text-center text-2xl font-semibold tracking-[0.24em]`}
            placeholder="BSYN-204"
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
        <p className="mt-2 text-sm leading-7 text-white/58">
          Update your city or upload a picture. This is the data BiteSync uses when you host or join rooms.
        </p>
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
      <div className="flex h-full min-h-0 max-h-full w-full flex-col overflow-hidden rounded-[24px] bg-[linear-gradient(145deg,#1d1721_0%,#24182a_100%)] shadow-[0_28px_80px_rgba(0,0,0,0.36)] sm:rounded-[28px]">
        <div className="relative min-h-0 flex-1 basis-0 overflow-hidden bg-[linear-gradient(180deg,#2a2230_0%,#1a1520_100%)]">
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

        <div className="max-h-[min(240px,42dvh)] shrink-0 space-y-2 overflow-y-auto overflow-x-hidden px-3 pb-3 pt-2 sm:px-4 sm:pb-4 sm:pt-3">
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

          {onHideForever ? (
            <button
              type="button"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                void onHideForever(restaurant);
              }}
              className="w-full rounded-xl border border-rose-400/25 bg-rose-500/10 py-2.5 text-center text-xs font-semibold text-rose-100/95 transition hover:bg-rose-500/18"
            >
              Hide forever
            </button>
          ) : null}

          {extraPhotos.length > 0 ? (
            <div className="flex gap-1.5 overflow-x-auto pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {extraPhotos.map((src, thumbIndex) => (
                <button
                  key={src}
                  type="button"
                  onPointerDown={(event) => event.stopPropagation()}
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
  mode,
  stage,
  roomMembers,
  restaurantVotes,
  sharedCategoryIds,
  restaurantFocusCategories,
  membersStillSwipingCategories,
  pendingCategories,
  pendingRestaurants,
  finalRestaurants,
  restaurantsLoading,
  loadedPlaceCount,
  swipePickLabel,
  myCategoryVotes,
  onStart,
  onChangeStage,
  onStartRestaurantRound,
  onCategoryBatchSubmit,
  onRestaurantDecision,
  onHideRestaurantForever,
  onRetryPlaces,
  onBack,
}: {
  room: RoomRecord | null;
  mode: RoomMode;
  stage: RoomStage;
  roomMembers: RoomMember[];
  restaurantVotes: RoomRestaurantVote[];
  sharedCategoryIds: string[];
  restaurantFocusCategories: Category[];
  membersStillSwipingCategories: RoomMember[];
  pendingCategories: typeof categories;
  pendingRestaurants: CityRestaurant[];
  finalRestaurants: CityRestaurant[];
  restaurantsLoading: boolean;
  loadedPlaceCount: number;
  swipePickLabel: string;
  myCategoryVotes: RoomCategoryVote[];
  onStart: () => void;
  onChangeStage: (value: RoomStage) => void;
  onStartRestaurantRound: () => void;
  onCategoryBatchSubmit: (likeIds: readonly string[]) => Promise<void>;
  onRestaurantDecision: (restaurantId: string, decision: "like" | "skip") => void | Promise<void>;
  onHideRestaurantForever?: (restaurant: CityRestaurant) => void | Promise<void>;
  onRetryPlaces: () => void;
  onBack: () => void;
}) {
  const currentRestaurant = pendingRestaurants[0] ?? null;
  const nextRestaurant = pendingRestaurants[1] ?? null;

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
          <p className="max-w-[300px] text-sm leading-6 text-white/58">
            Everyone in the room needs to finish each food style before you continue together.
          </p>
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
              {sharedCategoryIds.length > 0 ? "Categories you all liked" : "Categories for this round"}
            </h2>
            <p className="mt-2 text-sm leading-6 text-white/58">
              {sharedCategoryIds.length > 0
                ? "Places below follow these shared picks. Tap Start when everyone is ready to swipe restaurants."
                : "No single style was liked by everyone, so we combine what people liked to build your deck."}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {restaurantFocusCategories.length > 0 ? (
              restaurantFocusCategories.map((cat) => (
                <span
                  key={cat.id}
                  className="inline-flex items-center gap-1 rounded-full border border-white/12 bg-white/8 px-3 py-1.5 text-sm text-white/90"
                >
                  <span>{cat.emoji}</span>
                  {cat.title}
                </span>
              ))
            ) : (
              <p className="text-sm text-white/50">We will pull a broad set of places for your city.</p>
            )}
          </div>
          <button type="button" onClick={onStartRestaurantRound} className={primaryButtonClass}>
            Start
          </button>
        </div>
      ) : null}

      {stage === "categories" ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
          <p className="shrink-0 text-sm leading-snug text-white/70">
            Tap styles you want for this city. Untick = pass. Saved rows stay locked.
          </p>

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
            {categoryBatchSubmitting
              ? "Saving…"
              : pendingCategories.length > 0
                ? "Next · save & show restaurants"
                : "Next · continue"}
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

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {restaurantsLoading ? (
              <div className="rounded-2xl bg-white/6 px-3 py-2 text-center text-[11px] text-white/50">
                Loading {room?.city}…
              </div>
            ) : loadedPlaceCount === 0 ? (
              <div className="rounded-2xl border border-amber-400/20 bg-amber-400/8 p-4 text-center">
                <p className="text-sm font-medium text-white/88">No places loaded for {room?.city}</p>
                <p className="mt-2 text-xs leading-relaxed text-white/55">
                  The server needs a valid Google Maps key, or the search returned no results. You can retry the
                  fetch.
                </p>
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
                <p className="text-xs font-medium text-white/80">Restaurant round complete.</p>
                <button
                  type="button"
                  onClick={() => onChangeStage("final")}
                  className={`${primaryButtonCompactClass} mt-3`}
                >
                  Show final picks
                </button>
              </div>
            )}
          </div>
        </div>
      ) : null}

      {stage === "final" ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-0.5 pb-2">
            <div className="space-y-4">
              <div className="sticky top-0 z-10 -mx-0.5 mb-1 flex items-center gap-2 border-b border-white/10 bg-[#141117]/96 px-1 py-2 backdrop-blur-md">
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
                  <p className="text-[10px] text-white/45">Tap ← to leave the room</p>
                </div>
              </div>

              <div className="rounded-2xl bg-white/6 p-4">
                <p className="text-lg font-semibold text-white">{"Everyone's picks"}</p>
                <p className="mt-2 text-sm leading-6 text-white/58">
                  Restaurants liked by everyone in the room, highest rating first.
                </p>
              </div>

              <div className="space-y-2">
                {finalRestaurants.length > 0 ? (
                  finalRestaurants.map((restaurant) => (
                    <div key={restaurant.id} className="rounded-2xl bg-white/6 px-4 py-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-medium text-white">{restaurant.name}</p>
                          <p className="mt-1 text-xs leading-5 text-white/50">{restaurant.address}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-sm font-semibold text-white">{restaurant.rating?.toFixed(1) ?? "—"}</p>
                          <p className="text-xs text-white/45">{restaurant.userRatingCount ?? 0} reviews</p>
                        </div>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="rounded-2xl bg-white/6 p-4 text-sm leading-6 text-white/58">
                    No restaurant has been liked by everyone yet. Keep swiping or wait for the rest of the room to
                    finish.
                  </div>
                )}
              </div>

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
              {mode === "host" ? "Host mode" : "Joined"}
            </span>
          </div>

          <div className="rounded-[24px] bg-[linear-gradient(135deg,#ff7a18_0%,#ff4d8d_54%,#6a5cff_100%)] p-[1px]">
            <div className="rounded-[23px] bg-[#161218] px-4 py-3">
              <p className="text-xs text-white/55">{mode === "host" ? "Your room is live" : "You are inside the room"}</p>
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
                  <p className="text-base font-semibold text-white">Start when you are ready.</p>
                  <p className="mt-1.5 text-sm leading-snug text-white/58">
                    You can begin categories solo; late joiners still share only mutual likes.
                  </p>
                </div>

                <button type="button" onClick={handleStartClick} className={primaryButtonClass}>
                  Start swiping categories
                </button>
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
          <p className="text-sm text-white/40">Preparing your swipe deck</p>
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
            <div className="shrink-0 max-h-11 overflow-hidden border-t border-white/10 bg-[#141117]/95 px-2 py-1">
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
            <div className="flex min-h-[2.5rem] shrink-0 flex-col justify-center border-t border-white/10 bg-[#141117]/95 px-2 py-1">
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
  const gestureItemRef = useRef<T | null>(null);
  const isDraggingRef = useRef(false);
  const dragXRef = useRef(0);
  dragXRef.current = dragX;

  const itemKey = swipeItemStableKey(item);

  const reset = useCallback(() => {
    gestureItemRef.current = null;
    isDraggingRef.current = false;
    setDragX(0);
  }, []);

  useLayoutEffect(() => {
    reset();
  }, [itemKey, reset]);

  const commit = useCallback(
    (direction: "like" | "skip") => {
      const target = gestureItemRef.current;
      if (!target) return;
      isDraggingRef.current = true;
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
            isDraggingRef.current = false;
            gestureItemRef.current = null;
          }
        })();
      }, 85);
    },
    [onLike, onSkip, reset],
  );

  return (
    <div className={fillHeight ? "flex min-h-0 flex-1 flex-col" : "space-y-4"}>
      <div
        className={
          fillHeight
            ? "relative flex-1 touch-none select-none overflow-hidden rounded-[28px] bg-[#161218] min-h-0 max-h-full"
            : "relative h-[min(420px,58dvh)] min-h-[min(380px,52dvh)] touch-none select-none rounded-[28px] bg-[#161218] sm:h-[460px]"
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
          onPointerDown={(event) => {
            gestureItemRef.current = item;
            startXRef.current = event.clientX;
            isDraggingRef.current = true;
            try {
              event.currentTarget.setPointerCapture(event.pointerId);
            } catch {
              /* ignore */
            }
          }}
          onPointerMove={(event) => {
            if (!isDraggingRef.current) return;
            setDragX(event.clientX - startXRef.current);
          }}
          onPointerUp={(event) => {
            try {
              event.currentTarget.releasePointerCapture(event.pointerId);
            } catch {
              /* ignore */
            }
            const x = dragXRef.current;
            if (x > 90) {
              commit("like");
              return;
            }
            if (x < -90) {
              commit("skip");
              return;
            }
            reset();
          }}
          onPointerCancel={reset}
          className="absolute inset-0 z-10 isolate transform-gpu backface-hidden will-change-transform"
          style={{
            transform: `translate3d(${dragX}px,0,0) rotate(${dragX / 18}deg)`,
            transition: "none",
          }}
        >
          <div className={`relative h-full ${fillHeight ? "min-h-0 px-0.5 sm:px-1" : ""}`}>
            {Math.abs(dragX) > 18 ? (
              <div
                className={`absolute left-3 top-3 z-20 rounded-full border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.2em] sm:left-4 sm:top-4 sm:px-4 sm:py-2 sm:text-xs ${
                  dragX > 0
                    ? "border-emerald-300/50 bg-emerald-300/14 text-emerald-200"
                    : "border-rose-300/50 bg-rose-300/14 text-rose-200"
                }`}
              >
                {dragX > 0 ? likeLabel : skipLabel}
              </div>
            ) : null}
            {renderCard(item)}
          </div>
        </div>
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
  return `${cityCode}-${suffix}`;
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
    const voterKey =
      vote.user_id ??
      (typeof vote.member_name === "string" && vote.member_name ? `n:${vote.member_name}` : "");
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
