"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  categories,
  countries,
  participants,
  type Category,
  type Restaurant,
} from "@/data/mock-data";

type Step = "intro" | "profile" | "room" | "share" | "categories" | "restaurants" | "summary";
type Role = "host" | "guest";
type SwipeDecision = "like" | "skip";

type MenuState = {
  restaurantName: string;
  title: string;
  image: string;
  price: string;
};

type SwipeableRestaurant = Restaurant & {
  overlap: string[];
  matchScore: number;
};

export function FoodMatchApp() {
  const [step, setStep] = useState<Step>("intro");
  const [role, setRole] = useState<Role>("host");
  const [name, setName] = useState("Mia");
  const [countryCode, setCountryCode] = useState("US");
  const [city, setCity] = useState("Denver");
  const [roomCode, setRoomCode] = useState("BITE-204");
  const [qrCodeUrl, setQrCodeUrl] = useState("");
  const [categoryIndex, setCategoryIndex] = useState(0);
  const [restaurantIndex, setRestaurantIndex] = useState(0);
  const [categoryDragX, setCategoryDragX] = useState(0);
  const [restaurantDragX, setRestaurantDragX] = useState(0);
  const [likedCategories, setLikedCategories] = useState<string[]>([]);
  const [likedRestaurants, setLikedRestaurants] = useState<string[]>([]);
  const [menuModal, setMenuModal] = useState<MenuState | null>(null);
  const categoryDragStartRef = useRef<number | null>(null);
  const restaurantDragStartRef = useRef<number | null>(null);

  const countrySeed = useMemo(
    () => countries.find((country) => country.code === countryCode) ?? countries[1],
    [countryCode],
  );

  const currentCategory = categories[categoryIndex] ?? categories[categories.length - 1];

  const joinLink = useMemo(
    () =>
      `https://taste-together.app/join?room=${encodeURIComponent(roomCode)}&city=${encodeURIComponent(
        city,
      )}`,
    [city, roomCode],
  );

  useEffect(() => {
    let active = true;

    import("qrcode")
      .then((mod) =>
        mod.default.toDataURL(joinLink, {
          margin: 1,
          width: 220,
          color: { dark: "#131112", light: "#fff7ed" },
        }),
      )
      .then((url) => {
        if (active) {
          setQrCodeUrl(url);
        }
      })
      .catch(() => {
        if (active) {
          setQrCodeUrl("");
        }
      });

    return () => {
      active = false;
    };
  }, [joinLink]);

  const restaurantPool = useMemo<SwipeableRestaurant[]>(() => {
    return countrySeed.restaurants
      .map((restaurant) => {
        const overlap = restaurant.categoryIds.filter((id) => likedCategories.includes(id));
        return {
          ...restaurant,
          overlap,
          matchScore: overlap.length * 36 + restaurant.rating * 10,
        };
      })
      .sort((a, b) => b.matchScore - a.matchScore);
  }, [countrySeed.restaurants, likedCategories]);

  const currentRestaurant =
    restaurantPool[restaurantIndex] ?? restaurantPool[restaurantPool.length - 1];

  const shortlistedRestaurants = useMemo(() => {
    const liked = restaurantPool.filter((restaurant) => likedRestaurants.includes(restaurant.id));
    return liked.length > 0 ? liked : restaurantPool.slice(0, 3);
  }, [likedRestaurants, restaurantPool]);

  const progress = useMemo(() => {
    const order: Step[] = [
      "intro",
      "profile",
      "room",
      "share",
      "categories",
      "restaurants",
      "summary",
    ];
    return ((order.indexOf(step) + 1) / order.length) * 100;
  }, [step]);

  function handleCountryChange(code: string) {
    const nextCountry = countries.find((country) => country.code === code);
    setCountryCode(code);
    if (nextCountry) {
      setCity(nextCountry.city);
    }
  }

  function moveToRoom() {
    setRoomCode(
      `${city.slice(0, 4).toUpperCase() || "BITE"}-${countryCode}${String(
        participants.length + 21,
      ).padStart(2, "0")}`,
    );
    setStep("room");
  }

  function registerCategoryDecision(categoryId: string, decision: SwipeDecision) {
    if (decision === "like") {
      setLikedCategories((prev) => Array.from(new Set([...prev, categoryId])));
    } else {
      setLikedCategories((prev) => prev.filter((item) => item !== categoryId));
    }

    setCategoryDragX(0);
    if (categoryIndex >= categories.length - 1) {
      setRestaurantIndex(0);
      setStep("restaurants");
      return;
    }

    setCategoryIndex((prev) => prev + 1);
  }

  function registerRestaurantDecision(restaurantId: string, decision: SwipeDecision) {
    if (decision === "like") {
      setLikedRestaurants((prev) => Array.from(new Set([...prev, restaurantId])));
    } else {
      setLikedRestaurants((prev) => prev.filter((item) => item !== restaurantId));
    }

    setRestaurantDragX(0);
    if (restaurantIndex >= restaurantPool.length - 1) {
      setStep("summary");
      return;
    }

    setRestaurantIndex((prev) => prev + 1);
  }

  function handleCategoryPointerDown(clientX: number) {
    categoryDragStartRef.current = clientX;
  }

  function handleCategoryPointerMove(clientX: number) {
    if (categoryDragStartRef.current === null) return;
    setCategoryDragX(clientX - categoryDragStartRef.current);
  }

  function handleCategoryPointerUp() {
    if (categoryDragStartRef.current === null) return;
    if (categoryDragX > 110) registerCategoryDecision(currentCategory.id, "like");
    else if (categoryDragX < -110) registerCategoryDecision(currentCategory.id, "skip");
    else setCategoryDragX(0);
    categoryDragStartRef.current = null;
  }

  function handleRestaurantPointerDown(clientX: number) {
    restaurantDragStartRef.current = clientX;
  }

  function handleRestaurantPointerMove(clientX: number) {
    if (restaurantDragStartRef.current === null) return;
    setRestaurantDragX(clientX - restaurantDragStartRef.current);
  }

  function handleRestaurantPointerUp() {
    if (restaurantDragStartRef.current === null) return;
    if (restaurantDragX > 110) registerRestaurantDecision(currentRestaurant.id, "like");
    else if (restaurantDragX < -110) registerRestaurantDecision(currentRestaurant.id, "skip");
    else setRestaurantDragX(0);
    restaurantDragStartRef.current = null;
  }

  function resetAll() {
    setStep("intro");
    setCategoryIndex(0);
    setRestaurantIndex(0);
    setCategoryDragX(0);
    setRestaurantDragX(0);
    setLikedCategories([]);
    setLikedRestaurants([]);
    setMenuModal(null);
  }

  return (
    <main className="min-h-screen overflow-x-hidden bg-[#120f14] text-white">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -left-20 top-0 h-72 w-72 rounded-full bg-fuchsia-500/20 blur-3xl" />
        <div className="absolute right-0 top-20 h-80 w-80 rounded-full bg-orange-400/20 blur-3xl" />
        <div className="absolute bottom-0 left-1/3 h-72 w-72 rounded-full bg-cyan-400/15 blur-3xl" />
      </div>

      <div className="relative mx-auto flex min-h-screen w-full max-w-[560px] px-3 py-3 sm:px-4 sm:py-6">
        <div className="flex w-full flex-col rounded-[32px] border border-white/10 bg-[#0f0d11]/88 shadow-[0_40px_140px_rgba(0,0,0,0.55)] backdrop-blur-xl">
          <div className="flex items-center justify-between px-4 pt-4 text-xs font-semibold uppercase tracking-[0.24em] text-white/45 sm:px-5">
            <span>Taste Together</span>
            <span>{Math.round(progress)}%</span>
          </div>
          <div className="px-4 pt-3 sm:px-5">
            <div className="h-1.5 rounded-full bg-white/8">
              <div
                className="h-1.5 rounded-full bg-gradient-to-r from-orange-400 via-pink-500 to-cyan-400 transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>

          <div className="min-h-[100svh] px-4 pb-5 pt-6 sm:min-h-[760px] sm:px-5">
              {step === "intro" ? (
                <IntroScreen
                  onHost={() => {
                    setRole("host");
                    setStep("profile");
                  }}
                  onGuest={() => {
                    setRole("guest");
                    setStep("profile");
                  }}
                />
              ) : null}

              {step === "profile" ? (
                <ProfileScreen
                  role={role}
                  name={name}
                  countryCode={countryCode}
                  city={city}
                  onBack={() => setStep("intro")}
                  onNameChange={setName}
                  onCountryChange={handleCountryChange}
                  onCityChange={setCity}
                  onContinue={moveToRoom}
                />
              ) : null}

              {step === "room" ? (
                <RoomScreen
                  role={role}
                  roomCode={roomCode}
                  onBack={() => setStep("profile")}
                  onRoomCodeChange={setRoomCode}
                  onContinue={() => setStep("share")}
                />
              ) : null}

              {step === "share" ? (
                <ShareScreen
                  name={name}
                  city={city}
                  roomCode={roomCode}
                  joinLink={joinLink}
                  qrCodeUrl={qrCodeUrl}
                  onBack={() => setStep("room")}
                  onContinue={() => setStep("categories")}
                />
              ) : null}

              {step === "categories" ? (
                <CategorySwipeScreen
                  currentCategory={currentCategory}
                  nextCategory={categories[categoryIndex + 1]}
                  index={categoryIndex}
                  total={categories.length}
                  dragX={categoryDragX}
                  likedCategories={likedCategories}
                  onBack={() => setStep("share")}
                  onPointerDown={handleCategoryPointerDown}
                  onPointerMove={handleCategoryPointerMove}
                  onPointerUp={handleCategoryPointerUp}
                />
              ) : null}

              {step === "restaurants" ? (
                <RestaurantSwipeScreen
                  city={city}
                  currentRestaurant={currentRestaurant}
                  nextRestaurant={restaurantPool[restaurantIndex + 1]}
                  dragX={restaurantDragX}
                  index={restaurantIndex}
                  total={restaurantPool.length}
                  likedCategories={likedCategories}
                  onBack={() => setStep("categories")}
                  onPointerDown={handleRestaurantPointerDown}
                  onPointerMove={handleRestaurantPointerMove}
                  onPointerUp={handleRestaurantPointerUp}
                />
              ) : null}

              {step === "summary" ? (
                <SummaryScreen
                  city={city}
                  likedCategories={likedCategories}
                  shortlistedRestaurants={shortlistedRestaurants}
                  onRestart={resetAll}
                  onBack={() => setStep("restaurants")}
                  onOpenMenu={(restaurant, item) =>
                    setMenuModal({
                      restaurantName: restaurant.name,
                      title: item.title,
                      image: item.image,
                      price: item.price,
                    })
                  }
                />
              ) : null}
          </div>
        </div>
      </div>
      {menuModal ? <MenuModal state={menuModal} onClose={() => setMenuModal(null)} /> : null}
    </main>
  );
}

function IntroScreen({
  onHost,
  onGuest,
}: {
  onHost: () => void;
  onGuest: () => void;
}) {
  return (
    <div className="flex h-full flex-col justify-between">
      <div>
        <div className="inline-flex rounded-full border border-white/12 bg-white/6 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-white/75">
          Swipe-first food app
        </div>
        <h1 className="mt-6 text-5xl font-semibold leading-[0.94] text-white">
          Dinner picks.
          <br />
          Zero group drama.
        </h1>
        <p className="mt-5 text-base leading-8 text-white/62">
          Host a room, let everyone join with a QR, swipe food styles, then swipe restaurants like Tinder.
        </p>
      </div>

      <div className="space-y-4">
        <button
          onClick={onHost}
          className="w-full rounded-[28px] bg-[linear-gradient(135deg,#ff7a18_0%,#ff4d8d_52%,#8f6bff_100%)] px-5 py-5 text-left shadow-[0_20px_70px_rgba(255,101,101,0.35)]"
        >
          <p className="text-sm text-white/72">I am creating the room</p>
          <p className="mt-1 text-2xl font-semibold">Continue as host</p>
        </button>
        <button
          onClick={onGuest}
          className="w-full rounded-[28px] border border-white/10 bg-white/6 px-5 py-5 text-left"
        >
          <p className="text-sm text-white/55">I already have a code</p>
          <p className="mt-1 text-2xl font-semibold">Continue as guest</p>
        </button>
      </div>
    </div>
  );
}

function ProfileScreen({
  role,
  name,
  countryCode,
  city,
  onBack,
  onNameChange,
  onCountryChange,
  onCityChange,
  onContinue,
}: {
  role: Role;
  name: string;
  countryCode: string;
  city: string;
  onBack: () => void;
  onNameChange: (value: string) => void;
  onCountryChange: (value: string) => void;
  onCityChange: (value: string) => void;
  onContinue: () => void;
}) {
  return (
    <ScreenShell
      title="Where are you tonight?"
      subtitle="We use your country and city to know which restaurant world to load."
      onBack={onBack}
      actionLabel="Next"
      onAction={onContinue}
    >
      <div className="space-y-4">
        <Field label={role === "host" ? "Host name" : "Your name"}>
          <input
            value={name}
            onChange={(event) => onNameChange(event.target.value)}
            className={fieldClass}
            placeholder="Enter your name"
          />
        </Field>
        <Field label="Country">
          <select
            value={countryCode}
            onChange={(event) => onCountryChange(event.target.value)}
            className={fieldClass}
          >
            {countries.map((country) => (
              <option key={country.code} value={country.code}>
                {country.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="City">
          <input
            value={city}
            onChange={(event) => onCityChange(event.target.value)}
            className={fieldClass}
            placeholder="City"
          />
        </Field>
      </div>
    </ScreenShell>
  );
}

function RoomScreen({
  role,
  roomCode,
  onBack,
  onRoomCodeChange,
  onContinue,
}: {
  role: Role;
  roomCode: string;
  onBack: () => void;
  onRoomCodeChange: (value: string) => void;
  onContinue: () => void;
}) {
  return (
    <ScreenShell
      title={role === "host" ? "Lock in the room." : "Enter the room code."}
      subtitle="The room is where the group sync happens."
      onBack={onBack}
      actionLabel={role === "host" ? "Open room" : "Join room"}
      onAction={onContinue}
    >
      <div className="rounded-[30px] border border-white/10 bg-white/6 p-5">
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-white/45">Room code</p>
        <input
          value={roomCode}
          onChange={(event) => onRoomCodeChange(event.target.value.toUpperCase())}
          className={`${fieldClass} mt-4 text-center text-3xl font-semibold tracking-[0.24em]`}
          placeholder="BITE-204"
        />
      </div>
    </ScreenShell>
  );
}

function ShareScreen({
  name,
  city,
  roomCode,
  joinLink,
  qrCodeUrl,
  onBack,
  onContinue,
}: {
  name: string;
  city: string;
  roomCode: string;
  joinLink: string;
  qrCodeUrl: string;
  onBack: () => void;
  onContinue: () => void;
}) {
  return (
    <ScreenShell
      title="Share the room."
      subtitle="Friends scan the QR and land in the same session."
      onBack={onBack}
      actionLabel="Start swiping"
      onAction={onContinue}
    >
      <div className="space-y-4">
        <div className="grid place-items-center rounded-[32px] bg-[linear-gradient(180deg,#2b1d16_0%,#171217_100%)] p-5">
          {qrCodeUrl ? (
            <Image src={qrCodeUrl} alt="Room QR code" width={220} height={220} className="rounded-[28px]" />
          ) : (
            <div className="grid h-[220px] w-[220px] place-items-center rounded-[28px] bg-white/8 text-white/55">
              Loading QR...
            </div>
          )}
        </div>
        <div className="rounded-[28px] border border-white/10 bg-white/6 p-4">
          <p className="text-sm text-white/50">Hosted by {name}</p>
          <p className="mt-2 text-3xl font-semibold tracking-[0.18em]">{roomCode}</p>
          <p className="mt-3 text-sm leading-7 text-white/55">{city}</p>
          <p className="mt-2 break-all text-xs leading-6 text-white/42">{joinLink}</p>
        </div>
      </div>
    </ScreenShell>
  );
}

function CategorySwipeScreen({
  currentCategory,
  nextCategory,
  index,
  total,
  dragX,
  likedCategories,
  onBack,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: {
  currentCategory: Category;
  nextCategory?: Category;
  index: number;
  total: number;
  dragX: number;
  likedCategories: string[];
  onBack: () => void;
  onPointerDown: (clientX: number) => void;
  onPointerMove: (clientX: number) => void;
  onPointerUp: () => void;
}) {
  return (
    <SwipeShell
      title="Swipe food styles."
      subtitle="Right means yes. Left means no. No buttons, just vibe."
      onBack={onBack}
      counter={`${index + 1} / ${total}`}
      chips={likedCategories.map((id) => {
        const item = categories.find((entry) => entry.id === id);
        return item ? `${item.emoji} ${item.title}` : "";
      })}
    >
      <CardStackBackdrop label={nextCategory?.title} emoji={nextCategory?.emoji} />
      <article
        role="button"
        tabIndex={0}
        onPointerDown={(event) => onPointerDown(event.clientX)}
        onPointerMove={(event) => onPointerMove(event.clientX)}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        className={`relative z-10 h-[500px] w-full touch-none select-none rounded-[38px] bg-gradient-to-br ${currentCategory.accent} p-6 shadow-[0_30px_90px_rgba(0,0,0,0.24)] transition-transform`}
        style={{ transform: `translateX(${dragX}px) rotate(${dragX / 15}deg)` }}
      >
        <SwipeBadges dragX={dragX} />
        <div className="flex h-full flex-col justify-between">
          <div>
            <div className="flex items-center justify-between">
              <span className="rounded-full bg-black/12 px-4 py-2 text-xs font-semibold uppercase tracking-[0.24em] text-stone-800/75">
                Food mood
              </span>
              <span className="rounded-[24px] bg-white/70 px-4 py-3 text-5xl">{currentCategory.emoji}</span>
            </div>
            <h2 className="mt-6 text-5xl font-semibold text-stone-950">{currentCategory.title}</h2>
            <p className="mt-4 max-w-sm text-lg leading-8 text-stone-800/80">{currentCategory.blurb}</p>
          </div>

          <div className="grid gap-3">
            <div className="rounded-[26px] bg-white/62 p-4">
              <p className="text-sm text-stone-600">Swipe right if the group would actually enjoy this tonight.</p>
            </div>
            <div className="flex justify-between text-sm font-semibold text-stone-700/70">
              <span>Left to pass</span>
              <span>Right to keep</span>
            </div>
          </div>
        </div>
      </article>
    </SwipeShell>
  );
}

function RestaurantSwipeScreen({
  city,
  currentRestaurant,
  nextRestaurant,
  dragX,
  index,
  total,
  likedCategories,
  onBack,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: {
  city: string;
  currentRestaurant: SwipeableRestaurant;
  nextRestaurant?: SwipeableRestaurant;
  dragX: number;
  index: number;
  total: number;
  likedCategories: string[];
  onBack: () => void;
  onPointerDown: (clientX: number) => void;
  onPointerMove: (clientX: number) => void;
  onPointerUp: () => void;
}) {
  return (
    <SwipeShell
      title="Swipe restaurants."
      subtitle={`Now the app shows places in ${city} that match your food mood.`}
      onBack={onBack}
      counter={`${index + 1} / ${total}`}
      chips={likedCategories.map((id) => {
        const item = categories.find((entry) => entry.id === id);
        return item ? `${item.emoji} ${item.title}` : "";
      })}
    >
      <CardStackBackdrop label={nextRestaurant?.name} emoji="🍽️" />
      <article
        role="button"
        tabIndex={0}
        onPointerDown={(event) => onPointerDown(event.clientX)}
        onPointerMove={(event) => onPointerMove(event.clientX)}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        className="relative z-10 h-[540px] w-full touch-none select-none overflow-hidden rounded-[38px] border border-white/10 bg-[#1b161d] shadow-[0_30px_90px_rgba(0,0,0,0.28)] transition-transform"
        style={{ transform: `translateX(${dragX}px) rotate(${dragX / 18}deg)` }}
      >
        <SwipeBadges dragX={dragX} />
        <div className="relative h-full">
          <div className="absolute inset-0">
            <Image
              src={currentRestaurant.menuPreviews[0]?.image ?? "/next.svg"}
              alt={currentRestaurant.name}
              fill
              className="object-cover"
              sizes="(max-width: 768px) 100vw, 420px"
            />
            <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(13,10,14,0.05)_0%,rgba(13,10,14,0.72)_52%,rgba(13,10,14,0.98)_100%)]" />
          </div>

          <div className="relative flex h-full flex-col justify-between p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="rounded-full bg-white/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.24em] text-white/82">
                {currentRestaurant.mapLabel}
              </div>
              <div className="rounded-full bg-black/25 px-4 py-2 text-sm font-semibold text-white/85">
                {currentRestaurant.eta}
              </div>
            </div>

            <div>
              <div className="flex flex-wrap gap-2">
                {currentRestaurant.overlap.map((id) => {
                  const item = categories.find((entry) => entry.id === id);
                  if (!item) return null;
                  return (
                    <span key={id} className="rounded-full bg-white/12 px-3 py-2 text-xs font-semibold text-white/90">
                      {item.emoji} {item.title}
                    </span>
                  );
                })}
              </div>
              <h2 className="mt-5 text-4xl font-semibold leading-tight text-white">{currentRestaurant.name}</h2>
              <p className="mt-3 text-base leading-7 text-white/72">{currentRestaurant.vibe}</p>
              <div className="mt-5 flex items-center gap-3 text-sm font-medium text-white/76">
                <span>{currentRestaurant.priceLevel}</span>
                <span className="h-1 w-1 rounded-full bg-white/40" />
                <span>{currentRestaurant.reviewCount} reviews</span>
              </div>
            </div>
          </div>
        </div>
      </article>
    </SwipeShell>
  );
}

function SummaryScreen({
  city,
  likedCategories,
  shortlistedRestaurants,
  onRestart,
  onBack,
  onOpenMenu,
}: {
  city: string;
  likedCategories: string[];
  shortlistedRestaurants: SwipeableRestaurant[];
  onRestart: () => void;
  onBack: () => void;
  onOpenMenu: (restaurant: Restaurant, item: Restaurant["menuPreviews"][number]) => void;
}) {
  return (
    <div className="flex h-full flex-col gap-5">
      <div className="flex items-center justify-between">
        <button onClick={onBack} className={ghostButtonClass}>
          Back
        </button>
        <span className="rounded-full border border-white/10 bg-white/6 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
          Final picks
        </span>
      </div>

      <div className="rounded-[30px] bg-[linear-gradient(135deg,#ff7a18_0%,#ff4d8d_54%,#6a5cff_100%)] p-[1px]">
        <div className="rounded-[29px] bg-[#161218] p-5">
          <p className="text-sm text-white/52">Best matches in {city}</p>
          <h2 className="mt-3 text-4xl font-semibold leading-tight text-white">
            {shortlistedRestaurants[0]?.name ?? "No picks yet"}
          </h2>
          <div className="mt-4 flex flex-wrap gap-2">
            {likedCategories.map((id) => {
              const item = categories.find((entry) => entry.id === id);
              if (!item) return null;
              return (
                <span key={id} className="rounded-full bg-white/10 px-3 py-2 text-xs font-semibold text-white/85">
                  {item.emoji} {item.title}
                </span>
              );
            })}
          </div>
        </div>
      </div>

      <div className="space-y-3 overflow-y-auto pr-1">
        {shortlistedRestaurants.map((restaurant) => (
          <div key={restaurant.id} className="rounded-[28px] border border-white/10 bg-white/6 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-2xl font-semibold text-white">{restaurant.name}</p>
                <p className="mt-2 text-sm text-white/56">
                  {restaurant.mapLabel} • {restaurant.eta} • {restaurant.priceLevel}
                </p>
              </div>
              <span className="rounded-full bg-white/10 px-3 py-2 text-xs font-semibold text-white/82">
                {restaurant.rating.toFixed(1)}
              </span>
            </div>

            <div className="mt-4 grid gap-3">
              {restaurant.menuPreviews.slice(0, 2).map((item) => (
                <button
                  key={item.id}
                  onClick={() => onOpenMenu(restaurant, item)}
                  className="overflow-hidden rounded-[24px] border border-white/8 bg-black/15 text-left"
                >
                  <div className="relative h-36">
                    <Image
                      src={item.image}
                      alt={item.title}
                      fill
                      className="object-cover"
                      sizes="(max-width: 768px) 100vw, 420px"
                    />
                  </div>
                  <div className="flex items-center justify-between gap-3 p-4">
                    <div>
                      <p className="font-semibold text-white">{item.title}</p>
                      <p className="mt-1 text-sm text-white/55">Tap to open menu preview</p>
                    </div>
                    <span className="text-sm font-semibold text-orange-300">{item.price}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <button
        onClick={onRestart}
        className="mt-auto w-full rounded-full bg-white px-5 py-4 font-semibold text-stone-950"
      >
        Start over
      </button>
    </div>
  );
}

function ScreenShell({
  title,
  subtitle,
  children,
  onBack,
  onAction,
  actionLabel,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  onBack: () => void;
  onAction: () => void;
  actionLabel: string;
}) {
  return (
    <div className="flex h-full flex-col gap-6">
      <div className="flex items-center justify-between">
        <button onClick={onBack} className={ghostButtonClass}>
          Back
        </button>
        <span className="rounded-full border border-white/10 bg-white/6 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
          Setup
        </span>
      </div>

      <div>
        <h1 className="text-4xl font-semibold leading-tight text-white">{title}</h1>
        <p className="mt-4 text-base leading-8 text-white/58">{subtitle}</p>
      </div>

      <div className="flex-1">{children}</div>

      <button
        onClick={onAction}
        className="w-full rounded-full bg-[linear-gradient(135deg,#ff7a18_0%,#ff4d8d_54%,#6a5cff_100%)] px-5 py-4 font-semibold text-white shadow-[0_20px_60px_rgba(255,92,124,0.28)]"
      >
        {actionLabel}
      </button>
    </div>
  );
}

function SwipeShell({
  title,
  subtitle,
  counter,
  chips,
  children,
  onBack,
}: {
  title: string;
  subtitle: string;
  counter: string;
  chips: string[];
  children: React.ReactNode;
  onBack: () => void;
}) {
  return (
    <div className="flex h-full flex-col gap-5">
      <div className="flex items-center justify-between">
        <button onClick={onBack} className={ghostButtonClass}>
          Back
        </button>
        <span className="rounded-full border border-white/10 bg-white/6 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
          {counter}
        </span>
      </div>

      <div>
        <h1 className="text-4xl font-semibold leading-tight text-white">{title}</h1>
        <p className="mt-3 text-base leading-8 text-white/58">{subtitle}</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {chips.length > 0 ? (
          chips.map((chip) => (
            <span key={chip} className="rounded-full border border-white/10 bg-white/6 px-3 py-2 text-xs font-semibold text-white/82">
              {chip}
            </span>
          ))
        ) : (
          <span className="rounded-full border border-dashed border-white/10 px-3 py-2 text-xs font-semibold text-white/38">
            No likes yet
          </span>
        )}
      </div>

      <div className="relative flex flex-1 items-center justify-center">{children}</div>
    </div>
  );
}

function CardStackBackdrop({ label, emoji }: { label?: string; emoji?: string }) {
  return (
    <>
      <div className="absolute inset-x-5 top-8 h-[500px] rounded-[36px] bg-white/6 blur-[1px]" />
      <div className="absolute inset-x-8 top-12 h-[500px] rounded-[36px] bg-white/4" />
      {label ? (
        <div className="absolute bottom-2 text-center text-sm font-medium text-white/28">
          Up next: {emoji ? `${emoji} ` : ""}
          {label}
        </div>
      ) : null}
    </>
  );
}

function SwipeBadges({ dragX }: { dragX: number }) {
  return (
    <>
      <div
        className="absolute left-6 top-6 z-20 rounded-full border-2 border-rose-400 bg-black/18 px-4 py-2 text-sm font-black uppercase tracking-[0.24em] text-rose-300 transition"
        style={{ opacity: dragX < 0 ? Math.min(Math.abs(dragX) / 120, 1) : 0 }}
      >
        Nope
      </div>
      <div
        className="absolute right-6 top-6 z-20 rounded-full border-2 border-emerald-400 bg-black/18 px-4 py-2 text-sm font-black uppercase tracking-[0.24em] text-emerald-300 transition"
        style={{ opacity: dragX > 0 ? Math.min(dragX / 120, 1) : 0 }}
      >
        Yes
      </div>
    </>
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

function MenuModal({ state, onClose }: { state: MenuState; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-md">
      <div className="w-full max-w-3xl overflow-hidden rounded-[34px] border border-white/10 bg-[#151117] shadow-[0_30px_120px_rgba(0,0,0,0.5)]">
        <div className="grid md:grid-cols-[1.05fr_0.95fr]">
          <div className="relative min-h-[320px]">
            <Image src={state.image} alt={state.title} fill className="object-cover" sizes="(max-width: 768px) 100vw, 60vw" />
          </div>
          <div className="flex flex-col justify-between p-6">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-white/42">Menu preview</p>
              <h3 className="mt-4 text-4xl font-semibold text-white">{state.title}</h3>
              <p className="mt-3 text-lg text-white/58">{state.restaurantName}</p>
              <span className="mt-5 inline-flex rounded-full bg-white px-4 py-2 text-sm font-semibold text-stone-950">
                {state.price}
              </span>
            </div>
            <button onClick={onClose} className="mt-8 rounded-full bg-white px-5 py-4 font-semibold text-stone-950">
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const fieldClass =
  "w-full rounded-[24px] border border-white/10 bg-white/6 px-4 py-4 text-white outline-none transition focus:border-white/28";

const ghostButtonClass =
  "rounded-full border border-white/10 bg-white/6 px-4 py-2 text-sm font-semibold text-white/80";
