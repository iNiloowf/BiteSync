import { NextResponse } from "next/server";

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
].join(",");

const categoryMatchers: Array<{ id: string; patterns: RegExp[] }> = [
  {
    id: "pizza",
    patterns: [/pizza/i, /pizzeria/i],
  },
  {
    id: "burgers",
    patterns: [/burger/i, /fast[_\s-]?food/i, /american[_\s-]?restaurant/i, /fried[_\s-]?chicken/i],
  },
  {
    id: "italian",
    patterns: [/italian/i, /pasta/i],
  },
  {
    id: "sushi",
    patterns: [/sushi/i, /japanese/i, /ramen/i],
  },
  {
    id: "mexican",
    patterns: [/mexican/i, /taco/i],
  },
  {
    id: "healthy",
    patterns: [/vegan/i, /vegetarian/i, /salad/i, /healthy/i, /poke/i],
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
  return categoryMatchers
    .filter(({ patterns }) => patterns.some((pattern) => typeParts.some((part) => pattern.test(part))))
    .map(({ id }) => id);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const city = searchParams.get("city");
  const country = searchParams.get("country");

  if (!city || !country) {
    return NextResponse.json({ error: "City and country are required." }, { status: 400 });
  }

  if (!googleMapsApiKey) {
    return NextResponse.json(
      { error: "Missing GOOGLE_MAPS_API_KEY in the server environment." },
      { status: 500 },
    );
  }

  try {
    const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": googleMapsApiKey,
        "X-Goog-FieldMask": fieldMask,
      },
      body: JSON.stringify({
        textQuery: `restaurants in ${city}, ${country}`,
        maxResultCount: 8,
      }),
      cache: "no-store",
    });

    const payload = (await response.json()) as {
      places?: Array<{
        id: string;
        displayName?: { text?: string };
        formattedAddress?: string;
        rating?: number;
        userRatingCount?: number;
        priceLevel?: string;
        primaryType?: string;
        primaryTypeDisplayName?: { text?: string };
        types?: string[];
      }>;
      error?: { message?: string };
    };

    if (!response.ok) {
      return NextResponse.json(
        { error: payload.error?.message ?? "Google Places request failed." },
        { status: response.status },
      );
    }

    const places =
      payload.places?.map((place) => {
        const typeParts = [
          place.primaryType ?? "",
          place.primaryTypeDisplayName?.text ?? "",
          ...(place.types ?? []),
        ].filter(Boolean);

        return {
          id: place.id,
          name: place.displayName?.text ?? "Unknown place",
          address: place.formattedAddress ?? "",
          rating: place.rating ?? null,
          userRatingCount: place.userRatingCount ?? null,
          priceLevel: formatPriceLevel(place.priceLevel),
          primaryType: place.primaryTypeDisplayName?.text ?? null,
          categoryIds: inferCategoryIds(typeParts),
        };
      }) ?? [];

    return NextResponse.json({ places });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Restaurant lookup failed." },
      { status: 500 },
    );
  }
}
