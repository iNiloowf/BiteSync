"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";

import { countries } from "@/data/mock-data";
import { getSupabaseBrowserClient, hasSupabaseEnv } from "@/lib/supabase";

type Screen = "auth" | "home" | "profile" | "room";
type AuthMode = "signin" | "signup";
type RoomMode = "host" | "join";

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
  insert: (value: unknown) => unknown;
  upsert: (value: unknown) => unknown;
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

  const loadProfile = useCallback(
    async (user: User) => {
      if (!supabase) return;

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
        country_code: "US",
        city: "Denver",
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
      setMessage(error instanceof Error ? error.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSignOut() {
    if (!supabase) return;
    await supabase.auth.signOut();
    setMenuOpen(false);
    setActiveRoom(null);
  }

  async function handleSaveProfile() {
    if (!supabase || !session?.user) return;
    setSubmitting(true);
    setMessage("");

    try {
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
      setScreen("home");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save your profile.");
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
      setMessage(error instanceof Error ? error.message : "Avatar upload failed.");
    } finally {
      setAvatarUploading(false);
    }
  }

  async function handleHostRoom() {
    if (!supabase || !profile) return;
    setSubmitting(true);
    setMessage("");

    try {
      const code = createRoomCode(profile.city);
      const { data: roomData, error: roomError } = await getRoomsTable()
        .insert({
          code,
          host_name: profile.full_name,
          country_code: profile.country_code,
          city: profile.city,
        })
        .select()
        .single();

      if (roomError) throw roomError;

      await getMembersTable().insert({
        room_id: roomData.id,
        user_id: session?.user.id,
        name: profile.full_name,
      });

      setActiveRoom(roomData as RoomRecord);
      setRoomMode("host");
      setScreen("room");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not create room.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleJoinRoom() {
    if (!supabase || !profile) return;
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

      await getMembersTable().upsert({
        room_id: roomData.id,
        user_id: session?.user.id,
        name: profile.full_name,
      });

      setActiveRoom(roomData as RoomRecord);
      setRoomMode("join");
      setScreen("room");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not join room.");
    } finally {
      setSubmitting(false);
    }
  }

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
                fullName={fullName}
                countryCode={countryCode}
                city={city}
                submitting={submitting}
                avatarUploading={avatarUploading}
                fileInputRef={fileInputRef}
                onBack={() => setScreen("home")}
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
                onBack={() => setScreen("home")}
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
  return (
    <div className="flex h-full min-h-0 flex-col justify-between gap-5 overflow-hidden">
      <div>
        <div className="inline-flex rounded-full border border-white/10 bg-white/6 p-1">
          <button
            onClick={() => onModeChange("signup")}
            className={`rounded-full px-4 py-2 text-sm font-semibold ${mode === "signup" ? "bg-white text-stone-950" : "text-white/65"}`}
          >
            Sign up
          </button>
          <button
            onClick={() => onModeChange("signin")}
            className={`rounded-full px-4 py-2 text-sm font-semibold ${mode === "signin" ? "bg-white text-stone-950" : "text-white/65"}`}
          >
            Sign in
          </button>
        </div>

        <h1 className="mt-5 text-4xl font-semibold leading-tight text-white">
          {mode === "signup" ? "Create your BiteSync account." : "Welcome back."}
        </h1>
        <p className="mt-3 text-sm leading-7 text-white/58">
          {mode === "signup"
            ? "Sign up once, then every time you open the app you can go straight to Host or Join."
            : "Sign in to jump back into your rooms and keep your profile."}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-4 pb-2">
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

      <button onClick={onSubmit} disabled={submitting} className={primaryButtonClass}>
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
  fullName,
  countryCode,
  city,
  submitting,
  avatarUploading,
  fileInputRef,
  onBack,
  onFullNameChange,
  onCountryChange,
  onCityChange,
  onPickAvatar,
  onFileChange,
  onSave,
}: {
  profile: Profile | null;
  fullName: string;
  countryCode: string;
  city: string;
  submitting: boolean;
  avatarUploading: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onBack: () => void;
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
  onBack,
}: {
  profile: Profile | null;
  room: RoomRecord | null;
  mode: RoomMode;
  onBack: () => void;
}) {
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

        <div className="rounded-[28px] border border-white/10 bg-white/6 p-4">
          <p className="text-sm text-white/55">Next step</p>
          <p className="mt-2 text-base leading-7 text-white/78">
            This room is now stored in Supabase. The next integration step is live multi-user swipes and synced restaurant voting inside the room.
          </p>
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

const fieldClass =
  "w-full rounded-[22px] border border-white/10 bg-white/6 px-4 py-3 text-white outline-none transition focus:border-white/28";

const ghostButtonClass =
  "rounded-full border border-white/10 bg-white/6 px-4 py-2 text-sm font-semibold text-white/80";

const primaryButtonClass =
  "w-full rounded-full bg-[linear-gradient(135deg,#ff7a18_0%,#ff4d8d_54%,#6a5cff_100%)] px-5 py-4 font-semibold text-white shadow-[0_18px_55px_rgba(255,92,124,0.24)]";

const primaryCardClass =
  "w-full rounded-[28px] bg-[linear-gradient(135deg,#ff7a18_0%,#ff4d8d_52%,#8f6bff_100%)] px-5 py-5 text-left shadow-[0_20px_70px_rgba(255,101,101,0.28)]";

const menuItemClass =
  "w-full rounded-xl px-3 py-2 text-left text-sm font-medium text-white/80 transition hover:bg-white/8";
