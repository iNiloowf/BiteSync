import { NextResponse } from "next/server";

import { categories } from "@/data/mock-data";

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

/** One text search = one ranked slice; blending multiple cuisines in one query biases the first keywords (often pizza). */
function textQueryForLikedCategory(categoryId: string, label: string, city: string, country: string): string {
  const where = `${city}, ${country}`;
  switch (categoryId) {
    case "pizza":
      return `Pizza restaurants and pizzerias in ${where}`;
    case "burgers":
      return `Fast food burger chains quick service restaurants and drive-throughs in ${where}`;
    case "italian":
      return `Italian pasta restaurants in ${where}`;
    case "sushi":
      return `Sushi restaurants and Japanese dining in ${where}`;
    case "mexican":
      return `Mexican tacos and burrito restaurants in ${where}`;
    case "healthy":
      return `Healthy salad bowls vegan vegetarian restaurants in ${where}`;
    case "seafood":
      return `Seafood fish oyster lobster restaurants in ${where}`;
    case "indian":
      return `Indian curry tandoori restaurants in ${where}`;
    case "thai":
      return `Thai restaurants pad thai curry in ${where}`;
    case "korean":
      return `Korean BBQ bibimbap restaurants in ${where}`;
    case "cafe":
      return `Coffee shops cafes bakeries brunch in ${where}`;
    case "bbq":
      return `BBQ barbecue smokehouse grill restaurants in ${where}`;
    default:
      return `Popular ${label} restaurants in ${where}`;
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

async function searchTextPlaces(textQuery: string, maxResultCount: number): Promise<NormalizedPlace[]> {
  const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": googleMapsApiKey!,
      "X-Goog-FieldMask": fieldMask,
    },
    body: JSON.stringify({
      textQuery,
      maxResultCount,
    }),
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
  const likedParam = searchParams.get("likedCategories");
  const likedIds =
    likedParam
      ?.split(",")
      .map((part) => part.trim())
      .filter(Boolean) ?? [];

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
    let places: NormalizedPlace[];

    if (likedIds.length === 0) {
      const textQuery = `Restaurants and food in ${city}, ${country}`;
      places = await searchTextPlaces(textQuery, singleQueryLimit);
    } else if (likedIds.length === 1) {
      const id = likedIds[0]!;
      const cat = categories.find((c) => c.id === id);
      const label = cat?.title ?? id;
      const textQuery = textQueryForLikedCategory(id, label, city, country);
      places = await searchTextPlaces(textQuery, singleQueryLimit);
    } else {
      const queries = likedIds.map((id) => {
        const cat = categories.find((c) => c.id === id);
        const label = cat?.title ?? id;
        return textQueryForLikedCategory(id, label, city, country);
      });

      const settled = await Promise.allSettled(
        queries.map((textQuery) => searchTextPlaces(textQuery, perCategoryLimit)),
      );

      const buckets: NormalizedPlace[][] = [];
      for (const result of settled) {
        if (result.status === "fulfilled" && result.value.length > 0) {
          buckets.push(result.value);
        }
      }

      if (buckets.length === 0) {
        const fallback = `Restaurants and food in ${city}, ${country}`;
        places = await searchTextPlaces(fallback, singleQueryLimit);
      } else {
        places = mergeRoundRobin(buckets, mergedMax);
        if (places.length < 8) {
          const filler = await searchTextPlaces(`Popular restaurants in ${city}, ${country}`, singleQueryLimit);
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

    return NextResponse.json({ places });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Restaurant lookup failed." },
      { status: 500 },
    );
  }
}
