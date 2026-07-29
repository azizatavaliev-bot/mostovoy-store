export function optimizedImageUrl(source: string | null | undefined, width = 720): string {
  const src = String(source || "").trim();
  if (!src) return "";
  if (!src.startsWith("https://") && !src.startsWith("/uploads/")) return src;
  const safeWidth = Math.max(64, Math.min(1600, Math.round(width)));
  return `/api/images/webp?src=${encodeURIComponent(src)}&w=${safeWidth}`;
}
