BEGIN;
CREATE TABLE universe.runtime_secrets(tenant_id uuid NOT NULL,project_id uuid NOT NULL,name text NOT NULL CHECK(name~'^[A-Z][A-Z0-9_]{0,79}$'),ciphertext text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,project_id,name),FOREIGN KEY(tenant_id,project_id)REFERENCES universe.projects(tenant_id,id));
ALTER TABLE universe.runtime_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE universe.runtime_secrets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON universe.runtime_secrets TO universe_api USING(tenant_id=nullif(current_setting('universe.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('universe.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON universe.runtime_secrets TO universe_api;
INSERT INTO universe.migrations(version)VALUES('005_runtime_secrets');COMMIT;
