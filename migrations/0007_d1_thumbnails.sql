-- Independent derivatives: originals and processed R2 objects are never altered.
CREATE TABLE IF NOT EXISTS garment_thumbnails (
 image_id TEXT PRIMARY KEY REFERENCES garment_images(id) ON DELETE CASCADE,
 garment_id TEXT NOT NULL REFERENCES garments(id) ON DELETE CASCADE,
 data BLOB NOT NULL, mime_type TEXT NOT NULL CHECK(mime_type='image/webp'),
 byte_size INTEGER NOT NULL CHECK(byte_size BETWEEN 1 AND 30720),
 width INTEGER NOT NULL, height INTEGER NOT NULL, has_alpha INTEGER NOT NULL DEFAULT 0,
 source_sha256 TEXT NOT NULL, version TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_garment_thumbnails_owner ON garment_thumbnails(garment_id);
CREATE TABLE IF NOT EXISTS outfit_thumbnails (
 image_id TEXT PRIMARY KEY REFERENCES outfit_images(id) ON DELETE CASCADE,
 outfit_id TEXT NOT NULL REFERENCES outfits(id) ON DELETE CASCADE,
 data BLOB NOT NULL, mime_type TEXT NOT NULL CHECK(mime_type='image/webp'),
 byte_size INTEGER NOT NULL CHECK(byte_size BETWEEN 1 AND 30720),
 width INTEGER NOT NULL, height INTEGER NOT NULL, has_alpha INTEGER NOT NULL DEFAULT 0,
 source_sha256 TEXT NOT NULL, version TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS thumbnail_jobs (
 image_id TEXT PRIMARY KEY, owner TEXT NOT NULL CHECK(owner IN ('garment','outfit')),
 state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at TEXT NOT NULL DEFAULT '', lease TEXT, last_error TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_thumbnail_jobs_ready ON thumbnail_jobs(state,next_attempt_at);
CREATE TABLE IF NOT EXISTS thumbnail_usage (
 day TEXT PRIMARY KEY, r2_reads INTEGER NOT NULL DEFAULT 0,
 read_requests INTEGER NOT NULL DEFAULT 0, response_bytes INTEGER NOT NULL DEFAULT 0,
 rows_read INTEGER NOT NULL DEFAULT 0, rows_written INTEGER NOT NULL DEFAULT 0
);
CREATE TRIGGER IF NOT EXISTS thumbnail_garment_insert AFTER INSERT ON garment_images BEGIN
 INSERT OR IGNORE INTO thumbnail_jobs(image_id,owner,updated_at) VALUES(NEW.id,'garment',NEW.created_at);
END;
CREATE TRIGGER IF NOT EXISTS thumbnail_outfit_insert AFTER INSERT ON outfit_images BEGIN
 INSERT OR IGNORE INTO thumbnail_jobs(image_id,owner,updated_at) VALUES(NEW.id,'outfit',NEW.created_at);
END;
CREATE TRIGGER IF NOT EXISTS thumbnail_garment_move AFTER UPDATE OF garment_id ON garment_images BEGIN
 UPDATE garment_thumbnails SET garment_id=NEW.garment_id WHERE image_id=NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS thumbnail_garment_replace AFTER UPDATE OF sha256 ON garment_images WHEN OLD.sha256 IS NOT NEW.sha256 BEGIN
 DELETE FROM garment_thumbnails WHERE image_id=NEW.id;
 INSERT OR REPLACE INTO thumbnail_jobs(image_id,owner,updated_at) VALUES(NEW.id,'garment',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS thumbnail_outfit_replace AFTER UPDATE OF sha256 ON outfit_images WHEN OLD.sha256 IS NOT NEW.sha256 BEGIN
 DELETE FROM outfit_thumbnails WHERE image_id=NEW.id;
 INSERT OR REPLACE INTO thumbnail_jobs(image_id,owner,updated_at) VALUES(NEW.id,'outfit',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS thumbnail_garment_delete AFTER DELETE ON garment_images BEGIN
 DELETE FROM thumbnail_jobs WHERE image_id=OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS thumbnail_outfit_delete AFTER DELETE ON outfit_images BEGIN
 DELETE FROM thumbnail_jobs WHERE image_id=OLD.id;
END;
-- Resumable seed; no R2 reads during migration.
INSERT OR IGNORE INTO thumbnail_jobs(image_id,owner,updated_at) SELECT id,'garment',created_at FROM garment_images;
INSERT OR IGNORE INTO thumbnail_jobs(image_id,owner,updated_at) SELECT id,'outfit',created_at FROM outfit_images;
-- Bound derivative storage independently of original images and all other application data.
CREATE TABLE IF NOT EXISTS thumbnail_storage (id INTEGER PRIMARY KEY CHECK(id=1), byte_size INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO thumbnail_storage(id,byte_size) SELECT 1,
 (SELECT COALESCE(SUM(byte_size),0) FROM garment_thumbnails)+(SELECT COALESCE(SUM(byte_size),0) FROM outfit_thumbnails);
CREATE TRIGGER IF NOT EXISTS thumb_storage_g_insert BEFORE INSERT ON garment_thumbnails BEGIN
 SELECT CASE WHEN (SELECT byte_size FROM thumbnail_storage WHERE id=1)+NEW.byte_size-COALESCE((SELECT byte_size FROM garment_thumbnails WHERE image_id=NEW.image_id),0)>67108864 THEN RAISE(ABORT,'thumbnail_storage_budget') END;
END;
CREATE TRIGGER IF NOT EXISTS thumb_storage_o_insert BEFORE INSERT ON outfit_thumbnails BEGIN
 SELECT CASE WHEN (SELECT byte_size FROM thumbnail_storage WHERE id=1)+NEW.byte_size-COALESCE((SELECT byte_size FROM outfit_thumbnails WHERE image_id=NEW.image_id),0)>67108864 THEN RAISE(ABORT,'thumbnail_storage_budget') END;
END;
CREATE TRIGGER IF NOT EXISTS thumb_storage_g_added AFTER INSERT ON garment_thumbnails BEGIN UPDATE thumbnail_storage SET byte_size=byte_size+NEW.byte_size WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS thumb_storage_g_changed AFTER UPDATE OF byte_size ON garment_thumbnails BEGIN UPDATE thumbnail_storage SET byte_size=byte_size+NEW.byte_size-OLD.byte_size WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS thumb_storage_g_deleted AFTER DELETE ON garment_thumbnails BEGIN UPDATE thumbnail_storage SET byte_size=byte_size-OLD.byte_size WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS thumb_storage_o_added AFTER INSERT ON outfit_thumbnails BEGIN UPDATE thumbnail_storage SET byte_size=byte_size+NEW.byte_size WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS thumb_storage_o_changed AFTER UPDATE OF byte_size ON outfit_thumbnails BEGIN UPDATE thumbnail_storage SET byte_size=byte_size+NEW.byte_size-OLD.byte_size WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS thumb_storage_o_deleted AFTER DELETE ON outfit_thumbnails BEGIN UPDATE thumbnail_storage SET byte_size=byte_size-OLD.byte_size WHERE id=1; END;
