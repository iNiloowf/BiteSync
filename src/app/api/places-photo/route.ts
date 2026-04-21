import { NextResponse } from "next/server";

const googleMapsApiKey = process.env.GOOGLE_MAPS_API_KEY;

function encodeGoogleResourcePath(resourceName: string) {
  return resourceName.split("/").map(encodeURIComponent).join("/");
}

function decodePhotoName(encoded: string): string | null {
  try {
    return Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const encoded = searchParams.get("n");

  if (!encoded || !googleMapsApiKey) {
    return NextResponse.json({ error: "Missing photo token or server key." }, { status: 400 });
  }

  const photoName = decodePhotoName(encoded);
  if (!photoName || !photoName.startsWith("places/") || !photoName.includes("/photos/")) {
    return NextResponse.json({ error: "Invalid photo reference." }, { status: 400 });
  }

  const clampDim = (value: string | null, fallback: number) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(1600, Math.max(120, Math.round(n)));
  };

  const maxWidthPx = clampDim(searchParams.get("w"), 800);
  const maxHeightPx = clampDim(searchParams.get("h"), 600);

  const path = encodeGoogleResourcePath(photoName);
  const upstream = new URL(`https://places.googleapis.com/v1/${path}/media`);
  upstream.searchParams.set("maxWidthPx", String(maxWidthPx));
  upstream.searchParams.set("maxHeightPx", String(maxHeightPx));
  upstream.searchParams.set("key", googleMapsApiKey);

  try {
    const response = await fetch(upstream.toString(), { redirect: "follow", cache: "no-store" });

    if (!response.ok) {
      return NextResponse.json({ error: "Could not load photo." }, { status: 502 });
    }

    const buffer = await response.arrayBuffer();
    const contentType = response.headers.get("content-type") ?? "image/jpeg";

    return new NextResponse(buffer, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
      },
    });
  } catch {
    return NextResponse.json({ error: "Photo request failed." }, { status: 500 });
  }
}
