"use client";

import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AuthChangeEvent, Session, User } from "@supabase/supabase-js";

import { categories, countries, type Category } from "@/data/mock-data";
import { getSupabaseBrowserClient, hasSupabaseEnv, supabaseConfigError } from "@/lib/supabase";

type Screen = "auth" | "home" | "profile" | "room";
type AuthMode = "signin" | "signup";
type RoomMode = "host" | "join";
type RoomStage =
  | "lobby"
  | "categories"
  | "waiting_categories"
  | "category_match"
  | "restaurants"
  | "final";

type Profile = {
  id: string;
  full_name: string;
  country_code: string;
  city: string;
  avatar_url: string | null;
};

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

function roomMemberKey(member: RoomMember): string {
  return member.user_id ?? `n:${member.name}`;
}

export function FoodMatchApp() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);

  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
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
  const [roomStage, setRoomStage] = useState<RoomStage>("lobby");
  const [categoryVotes, setCategoryVotes] = useState<RoomCategoryVote[]>([]);
  const [restaurantVotes, setRestaurantVotes] = useState<RoomRestaurantVote[]>([]);
  const [swipePickLabel, setSwipePickLabel] = useState("");

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
  const memberCount = visibleRoomMembers.length || 1;

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

  const myLikedCategoriesInVoteOrder = useMemo(() => {
    const out: Category[] = [];
    const seen = new Set<string>();

    for (const vote of myCategoryVotes) {
      if (vote.decision !== "like") continue;
      if (seen.has(vote.category_id)) continue;
      seen.add(vote.category_id);
      const cat = categories.find((c) => c.id === vote.category_id);
      if (cat) out.push(cat);
    }

    return out;
  }, [myCategoryVotes]);

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
        : memberCount === 1
          ? soloLikedCategoryIds
          : [];

    return `${activeRoom.id}-dining-${focusIds.join("|") || "all"}`;
  }, [activeRoom, roomStage, restaurantFocusCategoryIds, soloLikedCategoryIds, memberCount]);

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

    const primary = visibleCityRestaurants
      .filter((restaurant) =>
        focusIds.length === 0
          ? memberCount === 1 &&
            restaurant.categoryIds.some((categoryId) => soloLikedCategoryIds.includes(categoryId))
          : restaurant.categoryIds.some((categoryId) => focusIds.includes(categoryId)),
      )
      .sort(sortByRating);

    if (primary.length > 0) return primary;
    if (visibleCityRestaurants.length > 0) {
      return [...visibleCityRestaurants].sort(sortByRating);
    }
    return primary;
  }, [memberCount, restaurantFocusCategoryIds, soloLikedCategoryIds, visibleCityRestaurants]);

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
        setProfile(data);
        setFullName(data.full_name);
        setCountryCode(data.country_code || "US");
        setCity(data.city || "Denver");
        return;
      }

      const fallbackProfile: Profile = {
        id: user.id,
        full_name: user.user_metadata.full_name ?? user.email?.split("@")[0] ?? "BiteSync User",
        country_code: user.user_metadata.country_code ?? "US",
        city: user.user_metadata.city ?? "Denver",
        avatar_url: null,
      };

      const { data: inserted } = await profilesQuery.upsert(fallbackProfile).select().single();

      setProfile(inserted ?? fallbackProfile);
      setFullName((inserted ?? fallbackProfile).full_name);
      setCountryCode((inserted ?? fallbackProfile).country_code);
      setCity((inserted ?? fallbackProfile).city);
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
      };

      const { data, error } = await getProfilesTable().upsert(payload).select().single();
      if (error) throw error;

      setProfile(data as Profile);
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
        })
        .select()
        .single();

      if (profileError) throw profileError;
      setProfile(updated as Profile);
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
    } catch (error) {
      setMessage(getErrorMessage(error, "Could not join room."));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCategoryDecision(categoryId: string, decision: "like" | "skip") {
    if (!supabase || !activeRoom || !profile || !currentUserId) return;

    try {
      const alreadyVoted = categoryVotes.some(
        (vote) =>
          vote.category_id === categoryId &&
          (vote.user_id === currentUserId ||
            (vote.user_id == null && vote.member_name === profile.full_name)),
      );

      let votesSnapshot = categoryVotes;

      if (!alreadyVoted) {
        const insertError = await insertCategoryVote({
          room_id: activeRoom.id,
          user_id: currentUserId,
          member_name: profile.full_name,
          category_id: categoryId,
          decision,
        });

        if (insertError) throw insertError;

        const optimistic: RoomCategoryVote = {
          id: `local-cat-${categoryId}-${Date.now()}`,
          user_id: currentUserId,
          member_name: profile.full_name,
          category_id: categoryId,
          decision,
        };

        votesSnapshot = [...categoryVotes, optimistic];

        setCategoryVotes((prev) => {
          if (
            prev.some(
              (vote) =>
                vote.category_id === categoryId &&
                (vote.user_id === currentUserId ||
                  (vote.user_id == null && vote.member_name === profile.full_name)),
            )
          ) {
            return prev;
          }

          return [...prev, optimistic];
        });
      }

      const picked = categories.find((c) => c.id === categoryId);
      setSwipePickLabel(`${decision === "like" ? "Liked" : "Passed"} · ${picked?.title ?? categoryId}`);

      const remaining = pendingCategories.filter((category) => category.id !== categoryId);
      if (remaining.length > 0) {
        return;
      }

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
      setMessage(getErrorMessage(error, "Could not save your category vote."));
    }
  }

  async function handleRestaurantDecision(restaurantId: string, decision: "like" | "skip") {
    if (!supabase || !activeRoom || !profile || !currentUserId) return;

    try {
      const alreadyVoted = restaurantVotes.some(
        (vote) =>
          vote.restaurant_id === restaurantId &&
          (vote.user_id === currentUserId ||
            (vote.user_id == null && vote.member_name === profile.full_name)),
      );

      if (!alreadyVoted) {
        const insertError = await insertRestaurantVote({
          room_id: activeRoom.id,
          user_id: currentUserId,
          member_name: profile.full_name,
          restaurant_id: restaurantId,
          decision,
        });

        if (insertError) throw insertError;

        const optimistic: RoomRestaurantVote = {
          id: `local-rest-${restaurantId}-${Date.now()}`,
          user_id: currentUserId,
          member_name: profile.full_name,
          restaurant_id: restaurantId,
          decision,
        };

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

      const remaining = pendingRestaurants.filter((restaurant) => restaurant.id !== restaurantId);
      if (remaining.length === 0) {
        setRoomStage("final");
      }
    } catch (error) {
      setMessage(getErrorMessage(error, "Could not save your restaurant vote."));
    }
  }

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

      setRoomMembers(rows);
    }

    void loadMembers();

    const pollMs = 4000;
    const pollId = window.setInterval(() => {
      void loadMembers();
    }, pollMs);

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void loadMembers();
      }
    };

    document.addEventListener("visibilitychange", onVisibility);

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
      .subscribe();

    return () => {
      active = false;
      window.clearInterval(pollId);
      document.removeEventListener("visibilitychange", onVisibility);
      void supabase.removeChannel(channel);
    };
  }, [activeRoom, supabase]);

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
          setCategoryVotes(rows.map((row) => ({ ...row, user_id: null })));
        }

        return;
      }

      setCategoryVotes(((primary.data as RoomCategoryVote[] | null) ?? []).filter(Boolean));
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
          setRestaurantVotes(rows.map((row) => ({ ...row, user_id: null })));
        }

        return;
      }

      setRestaurantVotes(((primary.data as RoomRestaurantVote[] | null) ?? []).filter(Boolean));
    }

    void loadCategoryVotes();
    void loadRestaurantVotes();

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
          void loadCategoryVotes();
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
      void supabase.removeChannel(categoryChannel);
      void supabase.removeChannel(restaurantChannel);
    };
  }, [activeRoom, supabase]);

  useEffect(() => {
    if (roomStage !== "waiting_categories") {
      return;
    }
    if (!allMembersFinishedCategories) {
      return;
    }
    setRoomStage("category_match");
  }, [roomStage, allMembersFinishedCategories]);

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
    if (!activeRoom) {
      return;
    }

    let active = true;
    const controller = new AbortController();
    const roomCity = activeRoom.city;
    const roomCountry = activeRoom.country_code;
    const enrich =
      roomStage === "restaurants" || roomStage === "final" || roomStage === "category_match";
    const focusIds =
      restaurantFocusCategoryIds.length > 0
        ? restaurantFocusCategoryIds
        : memberCount === 1
          ? soloLikedCategoryIds
          : [];

    async function loadRestaurants() {
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
          setCityRestaurants([]);
          return;
        }

        setCityRestaurants(payload.places ?? []);
      } catch (error) {
        if (!active || controller.signal.aborted) return;
        setMessage(getErrorMessage(error, "Could not load restaurants."));
        setCityRestaurants([]);
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
    };
    // `diningPlacesFetchKey` intentionally encodes roomStage + liked category ids for fetch timing.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- avoid refetching on every category swipe while still in "categories"
  }, [activeRoom, diningPlacesFetchKey]);

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
        <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[28px] border border-white/10 bg-[#141117]/92 shadow-[0_24px_100px_rgba(0,0,0,0.45)] backdrop-blur-xl">
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
                categoryVotes={categoryVotes}
                restaurantVotes={restaurantVotes}
                sharedCategoryIds={sharedCategoryIds}
                restaurantFocusCategories={restaurantFocusCategories}
                membersStillSwipingCategories={membersStillSwipingCategories}
                cityRestaurants={visibleCityRestaurants}
                pendingCategories={pendingCategories}
                pendingRestaurants={pendingRestaurants}
                finalRestaurants={finalRestaurants}
                restaurantsLoading={restaurantsLoading}
                swipePickLabel={swipePickLabel}
                myLikedCategoriesInVoteOrder={myLikedCategoriesInVoteOrder}
                onStart={() => setRoomStage("categories")}
                onChangeStage={setRoomStage}
                onStartRestaurantRound={() => setRoomStage("restaurants")}
                onCategoryDecision={handleCategoryDecision}
                onRestaurantDecision={handleRestaurantDecision}
                onBack={() => {
                  setSwipePickLabel("");
                  setScreen("home");
                  setRoomStage("lobby");
                }}
              />
            ) : null}
          </div>
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
  onSignOut,
}: {
  profile: Profile | null;
  screen: Screen;
  menuOpen: boolean;
  menuRef: React.RefObject<HTMLDivElement | null>;
  onToggleMenu: () => void;
  onOpenProfile: () => void;
  onSignOut: () => void;
}) {
  const subtitle =
    screen === "auth"
      ? "Real account"
      : screen === "profile"
        ? "Your profile"
        : screen === "room"
          ? "Room ready"
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
              <div className="absolute right-0 top-14 z-20 w-44 rounded-2xl border border-white/10 bg-[#1b1720] p-2 shadow-[0_18px_60px_rgba(0,0,0,0.35)]">
                <button onClick={onOpenProfile} className={menuItemClass}>
                  Profile
                </button>
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

function RestaurantSwipeCard({ restaurant }: { restaurant: CityRestaurant }) {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const photos = restaurant.photoUrls ?? [];
  const extraPhotos = photos.slice(1);

  useEffect(() => {
    if (!lightboxSrc) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [lightboxSrc]);

  const lightbox =
    lightboxSrc &&
    createPortal(
      <div
        className="fixed inset-0 z-[240] flex flex-col bg-black/90 p-3 sm:p-5"
        role="dialog"
        aria-modal="true"
        aria-label="Photo"
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            setLightboxSrc(null);
          }
        }}
      >
        <button
          type="button"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => setLightboxSrc(null)}
          className="absolute right-3 top-3 z-10 rounded-full border border-white/20 bg-white/10 px-3 py-1.5 text-xs font-semibold text-white/90 backdrop-blur-sm transition hover:bg-white/16"
        >
          Close
        </button>
        <div className="flex min-h-0 flex-1 items-center justify-center pt-10">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={lightboxSrc}
            alt=""
            className="max-h-[min(88dvh,920px)] w-auto max-w-[min(96vw,920px)] object-contain"
            onPointerDown={(event) => event.stopPropagation()}
          />
        </div>
      </div>,
      document.body,
    );

  return (
    <>
      <div className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-[24px] bg-[linear-gradient(145deg,#1d1721_0%,#24182a_100%)] shadow-[0_28px_80px_rgba(0,0,0,0.36)] sm:rounded-[28px]">
        <div className="relative min-h-0 flex-1 overflow-hidden bg-black/35">
          {photos[0] ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photos[0]} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full min-h-[32dvh] items-center justify-center text-sm text-white/40">No image</div>
          )}
        </div>

        <div className="shrink-0 space-y-2 px-3 pb-3 pt-2 sm:px-4 sm:pb-4 sm:pt-3">
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
              {extraPhotos.map((src) => (
                <button
                  key={src}
                  type="button"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => setLightboxSrc(src)}
                  className="relative h-12 w-12 shrink-0 overflow-hidden rounded-lg ring-1 ring-white/20 transition hover:ring-white/45 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-300/70 sm:h-14 sm:w-14"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={src} alt="" className="h-full w-full object-cover" loading="lazy" />
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      {lightbox}
    </>
  );
}

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
  categoryVotes,
  restaurantVotes,
  sharedCategoryIds,
  restaurantFocusCategories,
  membersStillSwipingCategories,
  cityRestaurants,
  pendingCategories,
  pendingRestaurants,
  finalRestaurants,
  restaurantsLoading,
  swipePickLabel,
  myLikedCategoriesInVoteOrder,
  onStart,
  onChangeStage,
  onStartRestaurantRound,
  onCategoryDecision,
  onRestaurantDecision,
  onBack,
}: {
  room: RoomRecord | null;
  mode: RoomMode;
  stage: RoomStage;
  roomMembers: RoomMember[];
  categoryVotes: RoomCategoryVote[];
  restaurantVotes: RoomRestaurantVote[];
  sharedCategoryIds: string[];
  restaurantFocusCategories: Category[];
  membersStillSwipingCategories: RoomMember[];
  cityRestaurants: CityRestaurant[];
  pendingCategories: typeof categories;
  pendingRestaurants: CityRestaurant[];
  finalRestaurants: CityRestaurant[];
  restaurantsLoading: boolean;
  swipePickLabel: string;
  myLikedCategoriesInVoteOrder: Category[];
  onStart: () => void;
  onChangeStage: (value: RoomStage) => void;
  onStartRestaurantRound: () => void;
  onCategoryDecision: (categoryId: string, decision: "like" | "skip") => void;
  onRestaurantDecision: (restaurantId: string, decision: "like" | "skip") => void;
  onBack: () => void;
}) {
  const categoryVotesCount = categoryVotes.filter((vote) => vote.decision === "like").length;
  const restaurantVotesCount = restaurantVotes.filter((vote) => vote.decision === "like").length;
  const currentCategory = pendingCategories[0] ?? null;
  const nextCategory = pendingCategories[1] ?? null;
  const currentRestaurant = pendingRestaurants[0] ?? null;
  const nextRestaurant = pendingRestaurants[1] ?? null;

  const [enterSwipe, setEnterSwipe] = useState(false);

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
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
          <div className="flex shrink-0 items-center justify-end text-[10px] tabular-nums text-white/40">
            {pendingCategories.length} left
          </div>

          {myLikedCategoriesInVoteOrder.length > 0 ? (
            <div className="shrink-0 rounded-lg border border-emerald-400/15 bg-emerald-400/6 px-2 py-1">
              <div className="flex max-h-6 items-center gap-1 overflow-x-auto overflow-y-hidden whitespace-nowrap [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {myLikedCategoriesInVoteOrder.map((cat) => (
                  <span
                    key={cat.id}
                    className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-white/8 px-1.5 py-0.5 text-[10px] font-medium text-white/85"
                  >
                    <span className="text-[11px] leading-none">{cat.emoji}</span>
                    {cat.title}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          <div className="min-h-0 flex-1">
            {currentCategory ? (
              <SwipePanel
                item={currentCategory}
                nextItem={nextCategory}
                likeLabel="Like"
                skipLabel="Pass"
                onLike={() => onCategoryDecision(currentCategory.id, "like")}
                onSkip={() => onCategoryDecision(currentCategory.id, "skip")}
                renderCard={(category) => (
                  <div
                    className={`min-h-[320px] rounded-[32px] bg-gradient-to-br ${category.accent} p-[1px] ${category.textures}`}
                  >
                    <div className="flex h-full flex-col rounded-[31px] bg-[#17131b]/96 p-6">
                      <div className="text-6xl">{category.emoji}</div>
                      <p className="mt-6 text-xs uppercase tracking-[0.28em] text-white/45">Food style</p>
                      <h3 className="mt-3 text-4xl font-semibold text-white">{category.title}</h3>
                      <p className="mt-4 text-base leading-7 text-white/65">{category.blurb}</p>
                    </div>
                  </div>
                )}
              />
            ) : (
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center rounded-2xl bg-white/6 p-4 text-center text-sm text-white/55">
                Updating room…
              </div>
            )}
          </div>
        </div>
      ) : null}

      {stage === "restaurants" ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
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

          <div className="min-h-0 flex-1">
            {restaurantsLoading ? (
              <div className="rounded-2xl bg-white/6 px-3 py-2 text-center text-[11px] text-white/50">
                Loading {room?.city}…
              </div>
            ) : currentRestaurant ? (
              <SwipePanel
                fillHeight
                item={currentRestaurant}
                nextItem={nextRestaurant}
                likeLabel="Like"
                skipLabel="Pass"
                onLike={() => onRestaurantDecision(currentRestaurant.id, "like")}
                onSkip={() => onRestaurantDecision(currentRestaurant.id, "skip")}
                renderCard={(restaurant) => <RestaurantSwipeCard restaurant={restaurant} />}
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
        <div className="space-y-4">
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
                No restaurant has been liked by everyone yet. Keep swiping or wait for the rest of the room to finish.
              </div>
            )}
          </div>

          <button onClick={() => onChangeStage("restaurants")} className={ghostButtonClass}>
            Back to restaurant cards
          </button>
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

            <div className="rounded-[28px] border border-white/10 bg-white/6 p-4">
              <div className="flex flex-wrap gap-2 text-xs text-white/55">
                <span className="rounded-full border border-white/10 bg-white/6 px-3 py-1.5">
                  Shared categories: {sharedCategoryIds.length}
                </span>
                <span className="rounded-full border border-white/10 bg-white/6 px-3 py-1.5">
                  Category likes: {categoryVotesCount}
                </span>
                <span className="rounded-full border border-white/10 bg-white/6 px-3 py-1.5">
                  Restaurant likes: {restaurantVotesCount}
                </span>
                <span className="rounded-full border border-white/10 bg-white/6 px-3 py-1.5">
                  City places: {cityRestaurants.length}
                </span>
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
        <div className="room-swipe-reveal flex min-h-0 flex-1 flex-col overflow-hidden pt-1">
          {stage === "waiting_categories" || stage === "category_match" ? (
            <div className="flex shrink-0 items-center justify-between gap-2 px-1 pb-2">
              <button type="button" onClick={onBack} className={ghostButtonClass}>
                Leave room
              </button>
              <span className="text-[11px] text-white/40">{room?.code}</span>
            </div>
          ) : null}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden pb-2">{swipeStages}</div>
          {(stage === "categories" || stage === "restaurants") &&
          (swipePickLabel || (stage === "categories" && myLikedCategoriesInVoteOrder.length > 0)) ? (
            <div className="shrink-0 max-h-11 overflow-hidden border-t border-white/10 bg-[#141117]/95 px-2 py-1">
              {stage === "categories" && myLikedCategoriesInVoteOrder.length > 0 ? (
                <p className="truncate text-[10px] leading-tight text-white/55" title={myLikedCategoriesInVoteOrder.map((c) => `${c.emoji} ${c.title}`).join(" · ")}>
                  <span className="text-white/35">Likes:</span>{" "}
                  {myLikedCategoriesInVoteOrder.map((c) => `${c.emoji}${c.title}`).join(" · ")}
                </p>
              ) : null}
              {swipePickLabel ? (
                <p
                  className={`truncate text-[10px] leading-tight text-white/70 ${stage === "categories" && myLikedCategoriesInVoteOrder.length > 0 ? "mt-0.5" : ""}`}
                  title={swipePickLabel}
                >
                  <span className="text-white/35">Last:</span> {swipePickLabel}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
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
  onLike: () => void;
  onSkip: () => void;
  renderCard: (item: T) => React.ReactNode;
  fillHeight?: boolean;
}) {
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startXRef = useRef(0);

  const reset = useCallback(() => {
    setDragX(0);
    setDragging(false);
  }, []);

  const commit = useCallback(
    (direction: "like" | "skip") => {
      setDragX(direction === "like" ? 420 : -420);
      window.setTimeout(() => {
        reset();
        if (direction === "like") {
          onLike();
        } else {
          onSkip();
        }
      }, 140);
    },
    [onLike, onSkip, reset],
  );

  return (
    <div className={fillHeight ? "flex min-h-0 flex-1 flex-col" : "space-y-4"}>
      <div
        className={fillHeight ? "relative min-h-0 flex-1 touch-none select-none" : "relative h-[340px] touch-none select-none"}
      >
        {nextItem ? (
          <div
            className={
              fillHeight
                ? "pointer-events-none absolute inset-2 z-0 overflow-hidden opacity-40 sm:inset-3"
                : "absolute inset-x-3 top-3 scale-[0.96] opacity-45"
            }
          >
            <div className={fillHeight ? "h-full min-h-0" : ""}>{renderCard(nextItem)}</div>
          </div>
        ) : null}

        <div
          onPointerDown={(event) => {
            startXRef.current = event.clientX;
            setDragging(true);
          }}
          onPointerMove={(event) => {
            if (!dragging) return;
            setDragX(event.clientX - startXRef.current);
          }}
          onPointerUp={() => {
            if (dragX > 90) {
              commit("like");
              return;
            }
            if (dragX < -90) {
              commit("skip");
              return;
            }
            reset();
          }}
          onPointerCancel={reset}
          className="absolute inset-0 z-10 will-change-transform"
          style={{
            transform: `translateX(${dragX}px) rotate(${dragX / 18}deg)`,
            transition: dragging ? "none" : "transform 160ms ease-out",
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

  if (memberCount === 1) {
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
