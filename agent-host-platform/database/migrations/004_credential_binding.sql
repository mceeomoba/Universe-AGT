BEGIN;
CREATE OR REPLACE FUNCTION universe.issue_credential(tenant uuid,subject uuid,kind text,digest text,scopes text[],days integer) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE result uuid; actor universe.credentials; BEGIN
SELECT * INTO actor FROM universe.credentials WHERE id=nullif(current_setting('universe.credential_id',true),'')::uuid AND revoked_at IS NULL AND expires_at>now();
IF actor.id IS NULL OR actor.tenant_id<>tenant OR actor.kind<>'operator' OR NOT('approve'=ANY(actor.scopes)) OR NOT(scopes<@actor.scopes) OR days NOT BETWEEN 1 AND 90 OR kind NOT IN('agent','host') OR tenant IS DISTINCT FROM nullif(current_setting('universe.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'Unauthorized';END IF;
IF kind='agent' THEN IF NOT EXISTS(SELECT 1 FROM universe.agents WHERE id=subject AND tenant_id=tenant) THEN RAISE EXCEPTION 'Subject unavailable';END IF;ELSE IF NOT EXISTS(SELECT 1 FROM universe.hosts WHERE id=subject AND tenant_id=tenant) THEN RAISE EXCEPTION 'Subject unavailable';END IF;END IF;
INSERT INTO universe.credentials(tenant_id,subject_id,kind,token_hash,scopes,expires_at)VALUES(tenant,subject,kind,digest,scopes,now()+days*interval '1 day')RETURNING id INTO result;RETURN result;END$$;
CREATE OR REPLACE FUNCTION universe.rotate_credential(tenant uuid,credential uuid,digest text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN
IF credential IS DISTINCT FROM nullif(current_setting('universe.credential_id',true),'')::uuid OR tenant IS DISTINCT FROM nullif(current_setting('universe.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'Unauthorized';END IF;
UPDATE universe.credentials SET token_hash=digest WHERE id=credential AND tenant_id=tenant AND 'rotate'=ANY(scopes) AND revoked_at IS NULL AND expires_at>now();IF NOT FOUND THEN RAISE EXCEPTION 'Credential unavailable';END IF;END$$;
INSERT INTO universe.migrations(version)VALUES('004_credential_binding');COMMIT;
