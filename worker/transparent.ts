/** Only full-resolution transparent candidates; never an opaque thumbnail fallback. */
export const transparentImageSql = (garment = "g.id") => `(SELECT p.id FROM garment_images p
  WHERE p.garment_id = ${garment} AND p.has_alpha = 1 AND p.variant IS NULL
    AND p.image_type IN ('processed', 'original') AND p.mime_type IN ('image/png', 'image/webp')
  ORDER BY CASE WHEN p.image_type = 'processed' THEN 0 ELSE 1 END, p.is_primary DESC, p.created_at DESC, p.id LIMIT 1)`;
