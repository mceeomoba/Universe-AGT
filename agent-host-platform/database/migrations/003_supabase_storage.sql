-- Apply separately on the approved Supabase project only, after foundation migrations.
-- No public policies; API's private service key signs narrowly scoped URLs.
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES('universe-artifacts','universe-artifacts',false,104857600,ARRAY['application/gzip','application/octet-stream'])
ON CONFLICT(id)DO UPDATE SET public=false,file_size_limit=EXCLUDED.file_size_limit,allowed_mime_types=EXCLUDED.allowed_mime_types;
