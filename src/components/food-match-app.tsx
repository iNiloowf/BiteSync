"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";

import { categories, countries } from "@/data/mock-data";
import { getSupabaseBrowserClient, hasSupabaseEnv, supabaseConfigError } from "@/lib/supabase";

type Screen = "auth" | "home" | "profile" | "room";
type AuthMode = "signin" | "signup";
type RoomMode = "host" | "join";
type RoomStage = "lobby" | "categories" | "restaurants" | "final";

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
    () => categoryVotes.filter((vote) => vote.user_id === currentUserId),
    [categoryVotes, currentUserId],
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

  const soloLikedCategoryIds = useMemo(
    () => myCategoryVotes.filter((vote) => vote.decision === "like").map((vote) => vote.category_id),
    [myCategoryVotes],
  );

  const restaurantCandidates = useMemo(
    () =>
      visibleCityRestaurants
        .filter((restaurant) =>
          sharedCategoryIds.length === 0
            ? memberCount === 1 &&
              restaurant.categoryIds.some((categoryId) => soloLikedCategoryIds.includes(categoryId))
            : restaurant.categoryIds.some((categoryId) => sharedCategoryIds.includes(categoryId)),
        )
        .sort((left, right) => {
          const leftPriority = left.rating !== null && left.rating >= 4 ? 1 : 0;
          const rightPriority = right.rating !== null && right.rating >= 4 ? 1 : 0;

          if (rightPriority !== leftPriority) {
            return rightPriority - leftPriority;
          }

          return (right.rating ?? 0) - (left.rating ?? 0);
        }),
    [memberCount, sharedCategoryIds, soloLikedCategoryIds, visibleCityRestaurants],
  );

  const myRestaurantVotes = useMemo(
    () => restaurantVotes.filter((vote) => vote.user_id === currentUserId),
    [currentUserId, restaurantVotes],
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
        setScreen("home");
      } else {
        setScreen("auth");
      }
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setEmail(nextSession?.user.email ?? "");
      if (nextSession?.user) {
        void loadProfile(nextSession.user);
        setScreen("home");
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
        (vote) => vote.user_id === currentUserId && vote.category_id === categoryId,
      );

      if (!alreadyVoted) {
        const { error } = await getCategoryVotesTable().insert({
          room_id: activeRoom.id,
          user_id: currentUserId,
          member_name: profile.full_name,
          category_id: categoryId,
          decision,
        });

        if (error) throw error;
      }

      const remaining = pendingCategories.filter((category) => category.id !== categoryId);
      if (remaining.length === 0) {
        setRoomStage("restaurants");
      }
    } catch (error) {
      setMessage(getErrorMessage(error, "Could not save your category vote."));
    }
  }

  async function handleRestaurantDecision(restaurantId: string, decision: "like" | "skip") {
    if (!supabase || !activeRoom || !profile || !currentUserId) return;

    try {
      const alreadyVoted = restaurantVotes.some(
        (vote) => vote.user_id === currentUserId && vote.restaurant_id === restaurantId,
      );

      if (!alreadyVoted) {
        const { error } = await getRestaurantVotesTable().insert({
          room_id: activeRoom.id,
          user_id: currentUserId,
          member_name: profile.full_name,
          restaurant_id: restaurantId,
          decision,
        });

        if (error) throw error;
      }

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
      const { data } = await client
        .from("room_members")
        .select("id,name,joined_at")
        .eq("room_id", roomId)
        .order("joined_at", { ascending: true });

      if (active) {
        setRoomMembers(((data as RoomMember[] | null) ?? []).filter(Boolean));
      }
    }

    void loadMembers();

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
      const { data } = await client
        .from("room_category_votes")
        .select("id,user_id,category_id,decision,member_name")
        .eq("room_id", roomId)
        .order("created_at", { ascending: true });

      if (active) {
        setCategoryVotes(((data as RoomCategoryVote[] | null) ?? []).filter(Boolean));
      }
    }

    async function loadRestaurantVotes() {
      const { data } = await client
        .from("room_restaurant_votes")
        .select("id,user_id,restaurant_id,decision,member_name")
        .eq("room_id", roomId)
        .order("created_at", { ascending: true });

      if (active) {
        setRestaurantVotes(((data as RoomRestaurantVote[] | null) ?? []).filter(Boolean));
      }
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
    if (!activeRoom) {
      return;
    }

    let active = true;
    const controller = new AbortController();
    const roomCity = activeRoom.city;
    const roomCountry = activeRoom.country_code;

    async function loadRestaurants() {
      setRestaurantsLoading(true);
      try {
        const response = await fetch(
          `/api/restaurants?city=${encodeURIComponent(roomCity)}&country=${encodeURIComponent(
            roomCountry,
          )}`,
          { signal: controller.signal },
        );

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
  }, [activeRoom]);

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
                profile={profile}
                room={activeRoom}
                mode={roomMode}
                stage={roomStage}
                roomMembers={visibleRoomMembers}
                categoryVotes={categoryVotes}
                restaurantVotes={restaurantVotes}
                sharedCategoryIds={sharedCategoryIds}
                cityRestaurants={visibleCityRestaurants}
                restaurantCandidates={restaurantCandidates}
                pendingCategories={pendingCategories}
                pendingRestaurants={pendingRestaurants}
                finalRestaurants={finalRestaurants}
                restaurantsLoading={restaurantsLoading}
                onStart={() => setRoomStage("categories")}
                onChangeStage={setRoomStage}
                onCategoryDecision={handleCategoryDecision}
                onRestaurantDecision={handleRestaurantDecision}
                onBack={() => {
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
        <div className="relative" ref={menuRef}>
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

function RoomScreen({
  profile,
  room,
  mode,
  stage,
  roomMembers,
  categoryVotes,
  restaurantVotes,
  sharedCategoryIds,
  cityRestaurants,
  restaurantCandidates,
  pendingCategories,
  pendingRestaurants,
  finalRestaurants,
  restaurantsLoading,
  onStart,
  onChangeStage,
  onCategoryDecision,
  onRestaurantDecision,
  onBack,
}: {
  profile: Profile | null;
  room: RoomRecord | null;
  mode: RoomMode;
  stage: RoomStage;
  roomMembers: RoomMember[];
  categoryVotes: RoomCategoryVote[];
  restaurantVotes: RoomRestaurantVote[];
  sharedCategoryIds: string[];
  cityRestaurants: CityRestaurant[];
  restaurantCandidates: CityRestaurant[];
  pendingCategories: typeof categories;
  pendingRestaurants: CityRestaurant[];
  finalRestaurants: CityRestaurant[];
  restaurantsLoading: boolean;
  onStart: () => void;
  onChangeStage: (value: RoomStage) => void;
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

  return (
    <div className="flex h-full min-h-0 flex-col gap-5 overflow-hidden">
      <div className="flex items-center justify-between">
        <button onClick={onBack} className={ghostButtonClass}>
          Back
        </button>
        <span className="rounded-full border border-white/10 bg-white/6 px-4 py-2 text-xs uppercase tracking-[0.24em] text-white/70">
          {mode === "host" ? "Host mode" : "Joined"}
        </span>
      </div>

      <div className="rounded-[30px] bg-[linear-gradient(135deg,#ff7a18_0%,#ff4d8d_54%,#6a5cff_100%)] p-[1px]">
        <div className="rounded-[29px] bg-[#161218] p-5">
          <p className="text-sm text-white/55">{mode === "host" ? "Your room is live" : "You are inside the room"}</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-[0.16em] text-white">{room?.code}</h1>
          <p className="mt-4 text-sm text-white/58">
            {room?.city}, {room?.country_code}
          </p>
        </div>
      </div>

      <div className="space-y-3">
        <div className="rounded-[28px] border border-white/10 bg-white/6 p-4">
          <p className="text-sm text-white/55">Logged in as</p>
          <p className="mt-2 text-2xl font-semibold text-white">{profile?.full_name}</p>
        </div>

        <div className="min-h-0 grid flex-1 gap-3 overflow-y-auto">
          <div className="rounded-[28px] border border-white/10 bg-white/6 p-4">
            <p className="text-sm text-white/55">People in this room</p>
            <div className="mt-3 space-y-2">
              {roomMembers.length > 0 ? (
                roomMembers.map((member) => (
                  <div key={member.id} className="flex items-center justify-between rounded-2xl bg-white/6 px-4 py-3">
                    <span className="font-medium text-white">{member.name}</span>
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
              <span className="text-xs uppercase tracking-[0.22em] text-white/45">{stage}</span>
            </div>

            {stage === "lobby" ? (
              <div className="mt-4 space-y-4">
                <div className="rounded-2xl bg-white/6 p-4">
                  <p className="text-lg font-semibold text-white">Start whenever you are ready.</p>
                  <p className="mt-2 text-sm leading-6 text-white/58">
                    You can start the category round even if nobody else has joined yet. If more people join later,
                    BiteSync will use only the shared liked categories.
                  </p>
                </div>

                <button onClick={onStart} className={primaryButtonClass}>
                  Start swiping categories
                </button>
              </div>
            ) : null}

            {stage === "categories" ? (
              <div className="mt-4 space-y-4">
                <div className="flex items-center justify-between text-sm text-white/55">
                  <span>Swipe right to like, left to pass.</span>
                  <span>{pendingCategories.length} left</span>
                </div>

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
                  <div className="rounded-2xl bg-white/6 p-4">
                    <p className="text-lg font-semibold text-white">Your category swipes are done.</p>
                    <p className="mt-2 text-sm leading-6 text-white/58">
                      {sharedCategoryIds.length > 0
                        ? "BiteSync found shared categories. Continue to restaurant swipes."
                        : "Waiting for shared category matches. If you are solo, your liked categories will be used."}
                    </p>
                    <button
                      onClick={() => onChangeStage("restaurants")}
                      className="mt-4 w-full rounded-full bg-white px-5 py-3 font-semibold text-stone-950"
                    >
                      Continue to restaurants
                    </button>
                  </div>
                )}
              </div>
            ) : null}

            {stage === "restaurants" ? (
              <div className="mt-4 space-y-4">
                <div className="flex items-center justify-between text-sm text-white/55">
                  <span>Only places rated 4.0+ appear first.</span>
                  <span>{pendingRestaurants.length} left</span>
                </div>

                {restaurantsLoading ? (
                  <div className="rounded-2xl bg-white/6 p-4 text-sm text-white/58">
                    Looking up restaurants in {room?.city}...
                  </div>
                ) : currentRestaurant ? (
                  <SwipePanel
                    item={currentRestaurant}
                    nextItem={nextRestaurant}
                    likeLabel="Like"
                    skipLabel="Pass"
                    onLike={() => onRestaurantDecision(currentRestaurant.id, "like")}
                    onSkip={() => onRestaurantDecision(currentRestaurant.id, "skip")}
                    renderCard={(restaurant) => (
                      <div className="min-h-[320px] rounded-[32px] bg-[linear-gradient(145deg,#1d1721_0%,#24182a_100%)] p-6 shadow-[0_28px_80px_rgba(0,0,0,0.36)]">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-xs uppercase tracking-[0.28em] text-white/38">Restaurant</p>
                            <h3 className="mt-3 text-3xl font-semibold text-white">{restaurant.name}</h3>
                          </div>
                          <div className="rounded-2xl bg-white/8 px-3 py-2 text-right">
                            <p className="text-lg font-semibold text-white">{restaurant.rating?.toFixed(1) ?? "—"}</p>
                            <p className="text-xs text-white/45">{restaurant.userRatingCount ?? 0} reviews</p>
                          </div>
                        </div>
                        <p className="mt-4 text-sm leading-6 text-white/58">{restaurant.address}</p>
                        <div className="mt-5 flex flex-wrap gap-2 text-xs text-white/70">
                          <span className="rounded-full border border-white/10 bg-white/6 px-3 py-1.5">
                            {restaurant.priceLevel ?? "Price unknown"}
                          </span>
                          <span className="rounded-full border border-white/10 bg-white/6 px-3 py-1.5">
                            {restaurant.primaryType ?? "Restaurant"}
                          </span>
                        </div>
                      </div>
                    )}
                  />
                ) : (
                  <div className="rounded-2xl bg-white/6 p-4">
                    <p className="text-lg font-semibold text-white">Restaurant swipes are done.</p>
                    <p className="mt-2 text-sm leading-6 text-white/58">
                      {restaurantCandidates.length > 0
                        ? "BiteSync is ready to show the places everyone liked."
                        : "No matching restaurants yet for the shared categories in this city."}
                    </p>
                    <button
                      onClick={() => onChangeStage("final")}
                      className="mt-4 w-full rounded-full bg-white px-5 py-3 font-semibold text-stone-950"
                    >
                      Show final picks
                    </button>
                  </div>
                )}
              </div>
            ) : null}

            {stage === "final" ? (
              <div className="mt-4 space-y-4">
                <div className="rounded-2xl bg-white/6 p-4">
                  <p className="text-lg font-semibold text-white">Final matches</p>
                  <p className="mt-2 text-sm leading-6 text-white/58">
                    These are the restaurants liked by everyone in the room. They are sorted from highest rating down.
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

                <button onClick={() => onChangeStage("restaurants")} className={ghostButtonClass}>
                  Back to restaurant cards
                </button>
              </div>
            ) : null}
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
}: {
  item: T;
  nextItem: T | null;
  likeLabel: string;
  skipLabel: string;
  onLike: () => void;
  onSkip: () => void;
  renderCard: (item: T) => React.ReactNode;
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
    <div className="space-y-4">
      <div className="relative h-[340px] touch-none select-none">
        {nextItem ? (
          <div className="absolute inset-x-3 top-3 scale-[0.96] opacity-45">{renderCard(nextItem)}</div>
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
          className="absolute inset-0 will-change-transform"
          style={{
            transform: `translateX(${dragX}px) rotate(${dragX / 18}deg)`,
            transition: dragging ? "none" : "transform 160ms ease-out",
          }}
        >
          <div className="relative h-full">
            {Math.abs(dragX) > 18 ? (
              <div
                className={`absolute left-4 top-4 z-10 rounded-full border px-4 py-2 text-xs font-semibold uppercase tracking-[0.24em] ${
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

      <div className="grid grid-cols-2 gap-3">
        <button onClick={() => commit("skip")} className={swipeGhostButtonClass}>
          Swipe left
        </button>
        <button onClick={() => commit("like")} className={swipePrimaryButtonClass}>
          Swipe right
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

function getSharedLikedIds<T extends { user_id: string | null; decision: "like" | "skip" }>(params: {
  votes: T[];
  itemKey: "category_id" | "restaurant_id";
  memberCount: number;
  fallbackVotes: T[];
}) {
  const { votes, itemKey, memberCount, fallbackVotes } = params;

  const likedCounts = new Map<string, Set<string>>();
  for (const vote of votes) {
    const itemId = (vote as T & Record<string, string>)[itemKey];
    if (!itemId || vote.decision !== "like" || !vote.user_id) continue;
    const users = likedCounts.get(itemId) ?? new Set<string>();
    users.add(vote.user_id);
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

const swipeGhostButtonClass =
  "w-full rounded-full border border-white/10 bg-white/6 px-5 py-3 font-semibold text-white/78";

const swipePrimaryButtonClass =
  "w-full rounded-full bg-white px-5 py-3 font-semibold text-stone-950";
