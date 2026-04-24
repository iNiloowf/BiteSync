import { NextResponse } from "next/server";

import { categories } from "@/data/categories";

const googleMapsApiKey = process.env.GOOGLE_MAPS_API_KEY;

const fieldMask = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.rating",
  "places.userRatingCount",
  "places.priceLevel",
  "places.primaryType",
  "places.primaryTypeDisplayName",
  "places.types",
  "places.photos",
].join(",");

/** Card-sized images load much faster than full 1200×1600 pulls. Lightbox can request larger w/h on the same route. */
function toPlacePhotoProxyUrl(photoName: string, maxWidthPx = 800, maxHeightPx = 600) {
  const n = Buffer.from(photoName, "utf8").toString("base64url");
  return `/api/places-photo?n=${encodeURIComponent(n)}&w=${maxWidthPx}&h=${maxHeightPx}`;
}

const categoryMatchers: Array<{ id: string; patterns: RegExp[] }> = [
  {
    id: "pizza",
    patterns: [/pizza/i, /pizzeria/i],
  },
  {
    id: "burgers",
    patterns: [
      /burger/i,
      /fast[_\s-]?food/i,
      /quick[_\s-]?service/i,
      /american[_\s-]?restaurant/i,
      /fried[_\s-]?chicken/i,
      /hamburger/i,
      /meal_takeaway/i,
      /take[_\s-]?away/i,
      /sandwich/i,
    ],
  },
  {
    id: "italian",
    patterns: [/italian/i, /pasta/i],
  },
  {
    id: "sushi",
    patterns: [/sushi/i, /sashimi/i, /izakaya/i, /ramen/i, /japanese/i],
  },
  {
    id: "mexican",
    patterns: [/mexican/i, /taco/i, /burrito/i, /tex[_\s-]?mex/i],
  },
  {
    id: "healthy",
    patterns: [/vegan/i, /vegetarian/i, /salad/i, /healthy/i, /poke/i, /acai/i],
  },
  {
    id: "seafood",
    patterns: [/seafood/i, /oyster/i, /lobster/i, /clam/i, /crab/i, /fish[_\s-]?market/i],
  },
  {
    id: "indian",
    patterns: [/indian/i, /biryani/i, /tandoor/i, /masala/i, /dosa/i, /naan/i],
  },
  {
    id: "thai",
    patterns: [/thai/i, /pad[_\s-]?thai/i, /tom[_\s-]?yum/i],
  },
  {
    id: "korean",
    patterns: [/korean/i, /bibimbap/i, /kimchi/i, /kbbq/i],
  },
  {
    id: "cafe",
    patterns: [/cafe/i, /coffee/i, /bakery/i, /boulangerie/i, /patisserie/i, /tea_house/i, /brunch/i, /espresso/i],
  },
  {
    id: "bbq",
    patterns: [/barbec/i, /bbq/i, /smokehouse/i, /smoked/i, /steakhouse/i, /grill[_\s-]?restaurant/i],
  },
];

function formatPriceLevel(value?: string) {
  if (!value) return null;
  const normalized = value.replace("PRICE_LEVEL_", "");
  switch (normalized) {
    case "FREE":
      return "Free";
    case "INEXPENSIVE":
      return "$";
    case "MODERATE":
      return "$$";
    case "EXPENSIVE":
      return "$$$";
    case "VERY_EXPENSIVE":
      return "$$$$";
    default:
      return normalized;
  }
}

function inferCategoryIds(typeParts: string[]) {
  const matched = categoryMatchers
    .filter(({ patterns }) => patterns.some((pattern) => typeParts.some((part) => pattern.test(part))))
    .map(({ id }) => id);
  return [...new Set(matched)];
}

type GooglePlace = {
  id: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  rating?: number;
  userRatingCount?: number;
  priceLevel?: string;
  primaryType?: string;
  primaryTypeDisplayName?: { text?: string };
  types?: string[];
  photos?: Array<{ name?: string }>;
};

type NormalizedPlace = {
  id: string;
  name: string;
  address: string;
  rating: number | null;
  userRatingCount: number | null;
  priceLevel: string | null;
  primaryType: string | null;
  categoryIds: string[];
  photoUrls: string[];
};

function normalizePlace(place: GooglePlace): NormalizedPlace {
  const displayName = place.displayName?.text ?? "";
  const primary = place.primaryType ?? "";
  const types = place.types ?? [];
  const typeParts = [
    displayName,
    displayName.toLowerCase().replace(/\s+/g, "_"),
    primary,
    primary.replace(/_/g, " "),
    place.primaryTypeDisplayName?.text ?? "",
    ...types,
    ...types.map((t) => t.replace(/_/g, " ").toLowerCase()),
  ].filter(Boolean);

  const photoUrls = (place.photos ?? [])
    .map((photo, index) =>
      photo.name ? toPlacePhotoProxyUrl(photo.name, index === 0 ? 800 : 280, index === 0 ? 600 : 210) : null,
    )
    .filter((url): url is string => Boolean(url))
    .slice(0, 6);

  return {
    id: place.id,
    name: place.displayName?.text ?? "Unknown place",
    address: place.formattedAddress ?? "",
    rating: place.rating ?? null,
    userRatingCount: place.userRatingCount ?? null,
    priceLevel: formatPriceLevel(place.priceLevel),
    primaryType: place.primaryTypeDisplayName?.text ?? null,
    categoryIds: inferCategoryIds(typeParts),
    photoUrls,
  };
}

/**
 * ISO-3166 codes in free-text queries are ambiguous ("CA" = Canada vs California).
 * Prefer a full country name in the Places text query; still pass `regionCode` on the request separately.
 */
function countryLabelForTextQuery(countryParam: string): string {
  const raw = countryParam.trim();
  if (!raw) return raw;
  if (raw.length > 3 && !/^[A-Za-z]{2}$/.test(raw)) {
    return raw;
  }
  const upper = raw.toUpperCase();
  const iso2ToName: Record<string, string> = {
    CA: "Canada",
    US: "United States",
    AE: "United Arab Emirates",
    GB: "United Kingdom",
    AU: "Australia",
    MX: "Mexico",
    IN: "India",
    FR: "France",
    DE: "Germany",
    JP: "Japan",
    KR: "South Korea",
  };
  return iso2ToName[upper] ?? raw;
}

/**
 * Richer place phrases reduce wrong-country matches (e.g. "CA" as California, or US cities with same names).
 * Canadian cities include province so Google anchors to the correct country.
 */
function searchPlacePhrase(city: string, countryLabel: string, regionCode?: string): string {
  const trimmed = city.trim();
  const key = trimmed.toLowerCase().replace(/[^a-z]/g, "");
  if (regionCode === "CA") {
    const provinceCity: Record<string, string> = {
      calgary: "Calgary, AB",
      edmonton: "Edmonton, AB",
      reddeer: "Red Deer, AB",
      lethbridge: "Lethbridge, AB",
      medicinehat: "Medicine Hat, AB",
      toronto: "Toronto, ON",
      mississauga: "Mississauga, ON",
      ottawa: "Ottawa, ON",
      hamilton: "Hamilton, ON",
      london: "London, ON",
      vancouver: "Vancouver, BC",
      victoria: "Victoria, BC",
      kelowna: "Kelowna, BC",
      montreal: "Montreal, QC",
      quebeccity: "Quebec City, QC",
      winnipeg: "Winnipeg, MB",
      saskatoon: "Saskatoon, SK",
      regina: "Regina, SK",
      halifax: "Halifax, NS",
    };
    const hint = provinceCity[key];
    if (hint) return `${hint}, Canada`;
  }
  return `${trimmed}, ${countryLabel}`;
}

type LatLng = { latitude: number; longitude: number };

type GeocodeLatLng = { lat: number; lng: number };

/** Places `Viewport`: southwest = `low`, northeast = `high` (per Google docs). */
type PlacesRectangle = { low: LatLng; high: LatLng };

/** Geocoding `viewport` / `bounds` for the city string (same city/country as signup → room). */
type CityGeocodeResult = {
  center: LatLng;
  /** When present, restricts Text Search to this rectangle (city footprint from Geocoding). */
  cityRectangle?: PlacesRectangle;
};

function geocodePointToLatLng(p: GeocodeLatLng): LatLng {
  return { latitude: p.lat, longitude: p.lng };
}

/** Slightly pad the box so edge listings are not clipped. */
function padPlacesRectangle(rect: PlacesRectangle, padDegrees = 0.02): PlacesRectangle {
  return {
    low: {
      latitude: rect.low.latitude - padDegrees,
      longitude: rect.low.longitude - padDegrees,
    },
    high: {
      latitude: rect.high.latitude + padDegrees,
      longitude: rect.high.longitude + padDegrees,
    },
  };
}

async function geocodeCityForSearch(
  address: string,
  apiKey: string,
  regionCode?: string,
): Promise<CityGeocodeResult | null> {
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", address);
  url.searchParams.set("key", apiKey);
  if (regionCode) {
    url.searchParams.set("components", `country:${regionCode}`);
  }
  const res = await fetch(url.toString(), { cache: "no-store" });
  const data = (await res.json()) as {
    status?: string;
    results?: Array<{
      geometry?: {
        location?: GeocodeLatLng;
        viewport?: { southwest?: GeocodeLatLng; northeast?: GeocodeLatLng };
        bounds?: { southwest?: GeocodeLatLng; northeast?: GeocodeLatLng };
      };
    }>;
  };
  if (data.status !== "OK") {
    return null;
  }
  const geometry = data.results?.[0]?.geometry;
  const loc = geometry?.location;
  if (!geometry || !loc) {
    return null;
  }
  const center = geocodePointToLatLng(loc);
  const box = geometry.viewport ?? geometry.bounds;
  const sw = box?.southwest;
  const ne = box?.northeast;
  if (sw && ne) {
    const raw: PlacesRectangle = {
      low: geocodePointToLatLng(sw),
      high: geocodePointToLatLng(ne),
    };
    if (raw.low.latitude <= raw.high.latitude) {
      return { center, cityRectangle: padPlacesRectangle(raw) };
    }
  }
  return { center };
}

/** Drop obvious wrong-country rows when Places still returns cross-border noise. */
function filterPlacesByTargetCountry(places: NormalizedPlace[], regionCode?: string): NormalizedPlace[] {
  if (!regionCode) return places;
  return places.filter((p) => {
    const a = p.address;
    if (!a) return true;
    const lower = a.toLowerCase();
    if (regionCode === "CA") {
      if (/\bunited states\b/i.test(a) || /\busa\b/i.test(lower)) return false;
      if (/, USA\s*$/i.test(a.trim())) return false;
      if (/\bcanada\b/i.test(lower)) return true;
      if (/\b(AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT)\s+[A-Z]\d[A-Z]\s*\d[A-Z]\d\b/i.test(a)) return true;
      return true;
    }
    if (regionCode === "US") {
      if (/\bcanada\b/i.test(lower)) return false;
    }
    return true;
  });
}

/** One text search = one ranked slice; blending multiple cuisines in one query biases the first keywords (often pizza). */
function textQueryForLikedCategory(categoryId: string, label: string, where: string): string {
  switch (categoryId) {
    case "pizza":
      return `Pizza restaurants and pizzerias near ${where}`;
    case "burgers":
      return `Fast food burger chains quick service restaurants and drive-throughs near ${where}`;
    case "italian":
      return `Italian pasta restaurants near ${where}`;
    case "sushi":
      return `Sushi restaurants and Japanese dining near ${where}`;
    case "mexican":
      return `Mexican tacos and burrito restaurants near ${where}`;
    case "healthy":
      return `Healthy salad bowls vegan vegetarian restaurants near ${where}`;
    case "seafood":
      return `Seafood fish oyster lobster restaurants near ${where}`;
    case "indian":
      return `Indian curry tandoori restaurants near ${where}`;
    case "thai":
      return `Thai restaurants pad thai curry near ${where}`;
    case "korean":
      return `Korean BBQ bibimbap restaurants near ${where}`;
    case "cafe":
      return `Coffee shops cafes bakeries brunch near ${where}`;
    case "bbq":
      return `BBQ barbecue smokehouse grill restaurants near ${where}`;
    default:
      return `Popular ${label} restaurants near ${where}`;
  }
}

function mergeRoundRobin(buckets: NormalizedPlace[][], maxTotal: number): NormalizedPlace[] {
  const seen = new Set<string>();
  const out: NormalizedPlace[] = [];
  let round = 0;
  const maxRounds = 40;

  while (out.length < maxTotal && round < maxRounds) {
    let any = false;
    for (const bucket of buckets) {
      const place = bucket[round];
      if (!place) continue;
      if (seen.has(place.id)) continue;
      seen.add(place.id);
      out.push(place);
      any = true;
      if (out.length >= maxTotal) return out;
    }
    if (!any) break;
    round += 1;
  }

  return out;
}

function dedupePlacesById(places: NormalizedPlace[]): NormalizedPlace[] {
  const seen = new Set<string>();
  const out: NormalizedPlace[] = [];
  for (const p of places) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

function sortByRatingThenVolume(a: NormalizedPlace, b: NormalizedPlace): number {
  const ra = a.rating ?? -1;
  const rb = b.rating ?? -1;
  if (rb !== ra) return rb - ra;
  return (b.userRatingCount ?? 0) - (a.userRatingCount ?? 0);
}

function sortByVolumeThenRating(a: NormalizedPlace, b: NormalizedPlace): number {
  const ca = a.userRatingCount ?? 0;
  const cb = b.userRatingCount ?? 0;
  if (cb !== ca) return cb - ca;
  return (b.rating ?? 0) - (a.rating ?? 0);
}

/** Alternates “high stars” vs “many reviews” so the deck is not only one signal. */
function interleaveRatingAndPopular(places: NormalizedPlace[], maxTotal: number): NormalizedPlace[] {
  if (places.length === 0) return places;
  const byRating = [...places].sort(sortByRatingThenVolume);
  const byPopular = [...places].sort(sortByVolumeThenRating);
  const seen = new Set<string>();
  const out: NormalizedPlace[] = [];
  let i = 0;
  while (out.length < maxTotal && i < Math.max(byRating.length, byPopular.length)) {
    for (const p of [byRating[i], byPopular[i]]) {
      if (p && !seen.has(p.id)) {
        seen.add(p.id);
        out.push(p);
        if (out.length >= maxTotal) return out;
      }
    }
    i += 1;
  }
  for (const p of places) {
    if (out.length >= maxTotal) break;
    if (!seen.has(p.id)) {
      seen.add(p.id);
      out.push(p);
    }
  }
  return out;
}

type RestaurantSortMode = "relevance" | "balanced" | "rating" | "popular" | "discovery";

async function finalizeRestaurantOrder(
  places: NormalizedPlace[],
  sort: RestaurantSortMode,
  where: string,
  regionCode: string | undefined,
  searchOpts: SearchTextOptions,
  maxTotal: number,
): Promise<NormalizedPlace[]> {
  let list = filterPlacesByTargetCountry(places, regionCode);
  let discoveryHead: NormalizedPlace[] = [];

  if (sort === "discovery") {
    try {
      const novel = await searchTextPlaces(`Recently opened new restaurants near ${where}`, 8, searchOpts);
      discoveryHead = filterPlacesByTargetCountry(novel, regionCode).slice(0, 7);
    } catch {
      discoveryHead = [];
    }
    const headIds = new Set(discoveryHead.map((p) => p.id));
    list = list.filter((p) => !headIds.has(p.id));
  }

  let orderedBody: NormalizedPlace[];
  switch (sort) {
    case "relevance":
      orderedBody = [...list];
      break;
    case "rating":
      orderedBody = [...list].sort(sortByRatingThenVolume);
      break;
    case "popular":
      orderedBody = [...list].sort(sortByVolumeThenRating);
      break;
    case "balanced":
    case "discovery":
    default:
      orderedBody = interleaveRatingAndPopular(list, maxTotal);
      break;
  }

  return dedupePlacesById([...discoveryHead, ...orderedBody]).slice(0, maxTotal);
}

type SearchTextOptions = {
  regionCode?: string;
  /** Hard limit: only results inside this box (from Geocoding viewport for the user's city). */
  locationRestriction?: { rectangle: PlacesRectangle };
  /** Soft bias when we have a center but no city rectangle (circle not allowed on `locationRestriction`). */
  locationBias?: {
    circle: { center: LatLng; radius: number };
  };
};

async function searchTextPlaces(
  textQuery: string,
  maxResultCount: number,
  options?: SearchTextOptions,
): Promise<NormalizedPlace[]> {
  const body: Record<string, unknown> = { textQuery, maxResultCount };
  if (options?.regionCode) {
    body.regionCode = options.regionCode;
  }
  if (options?.locationRestriction) {
    body.locationRestriction = options.locationRestriction;
  } else if (options?.locationBias) {
    body.locationBias = options.locationBias;
  }
  const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": googleMapsApiKey!,
      "X-Goog-FieldMask": fieldMask,
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  const payload = (await response.json()) as {
    places?: GooglePlace[];
    error?: { message?: string };
  };

  if (!response.ok) {
    throw new Error(payload.error?.message ?? "Google Places request failed.");
  }

  return (payload.places ?? []).map(normalizePlace);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const city = searchParams.get("city");
  const country = searchParams.get("country");
  const countryLabel = country ? countryLabelForTextQuery(country) : "";
  const regionCode = country?.trim().match(/^[A-Za-z]{2}$/) ? country.trim().toUpperCase() : undefined;
  const likedParam = searchParams.get("likedCategories");
  const likedIds =
    likedParam
      ?.split(",")
      .map((part) => part.trim())
      .filter(Boolean) ?? [];

  const sortParam = searchParams.get("sort");
  const sort: RestaurantSortMode =
    sortParam === "relevance" || sortParam === "rating" || sortParam === "popular" || sortParam === "discovery"
      ? sortParam
      : "balanced";

  if (!city || !country) {
    return NextResponse.json({ error: "City and country are required." }, { status: 400 });
  }

  if (!googleMapsApiKey) {
    return NextResponse.json(
      { error: "Missing GOOGLE_MAPS_API_KEY in the server environment." },
      { status: 500 },
    );
  }

  const perCategoryLimit = 12;
  const singleQueryLimit = 20;
  const mergedMax = 30;

  try {
    const where = searchPlacePhrase(city, countryLabel, regionCode);
    const geo = await geocodeCityForSearch(where, googleMapsApiKey, regionCode);
    const searchOpts: SearchTextOptions = { regionCode };
    if (geo?.cityRectangle) {
      searchOpts.locationRestriction = { rectangle: geo.cityRectangle };
    } else if (geo) {
      searchOpts.locationBias = { circle: { center: geo.center, radius: 52000 } };
    }

    let places: NormalizedPlace[];

    if (likedIds.length === 0) {
      const textQuery = `Restaurants and food near ${where}`;
      places = await searchTextPlaces(textQuery, singleQueryLimit, searchOpts);
    } else if (likedIds.length === 1) {
      const id = likedIds[0]!;
      const cat = categories.find((c) => c.id === id);
      const label = cat?.title ?? id;
      const textQuery = textQueryForLikedCategory(id, label, where);
      places = await searchTextPlaces(textQuery, singleQueryLimit, searchOpts);
    } else {
      const queries = likedIds.map((id) => {
        const cat = categories.find((c) => c.id === id);
        const label = cat?.title ?? id;
        return textQueryForLikedCategory(id, label, where);
      });

      const settled = await Promise.allSettled(
        queries.map((textQuery) => searchTextPlaces(textQuery, perCategoryLimit, searchOpts)),
      );

      const buckets: NormalizedPlace[][] = [];
      for (const result of settled) {
        if (result.status === "fulfilled" && result.value.length > 0) {
          buckets.push(result.value);
        }
      }

      if (buckets.length === 0) {
        const fallback = `Restaurants and food near ${where}`;
        places = await searchTextPlaces(fallback, singleQueryLimit, searchOpts);
      } else {
        places = mergeRoundRobin(buckets, mergedMax);
        if (places.length < 8) {
          const filler = await searchTextPlaces(
            `Popular restaurants near ${where}`,
            singleQueryLimit,
            searchOpts,
          );
          const seen = new Set(places.map((p) => p.id));
          for (const p of filler) {
            if (places.length >= mergedMax) break;
            if (seen.has(p.id)) continue;
            seen.add(p.id);
            places.push(p);
          }
        }
      }
    }

    places = filterPlacesByTargetCountry(places, regionCode);

    const maxPlaces = likedIds.length > 1 ? mergedMax : singleQueryLimit;
    places = await finalizeRestaurantOrder(places, sort, where, regionCode, searchOpts, maxPlaces);

    return NextResponse.json({ places });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Restaurant lookup failed." },
      { status: 500 },
    );
  }
}
