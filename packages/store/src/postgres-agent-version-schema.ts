export const POSTGRES_AGENT_VERSION_SCHEMA_VERSION = 3;

export function postgresAgentVersionSchemaSql(schema: string): string {
  return `
    INSERT INTO ${schema}.schema_migrations(component, version)
      VALUES ('agent_version_authority', ${POSTGRES_AGENT_VERSION_SCHEMA_VERSION})
      ON CONFLICT (component) DO NOTHING;

    CREATE TABLE IF NOT EXISTS ${schema}.agent_versions (
      tenant_id text NOT NULL,
      agent_version_id text NOT NULL,
      content_digest text NOT NULL
        CHECK (content_digest ~ '^sha256:[a-f0-9]{64}$'),
      asset_json jsonb NOT NULL
        CHECK (jsonb_typeof(asset_json) = 'object'),
      created_at timestamptz NOT NULL,
      PRIMARY KEY (tenant_id, agent_version_id)
    );

    CREATE INDEX IF NOT EXISTS agent_versions_list_idx
      ON ${schema}.agent_versions(tenant_id, agent_version_id);

    CREATE TABLE IF NOT EXISTS ${schema}.agent_version_deployments (
      tenant_id text NOT NULL,
      agent_version_id text NOT NULL,
      content_digest text NOT NULL
        CHECK (content_digest ~ '^sha256:[a-f0-9]{64}$'),
      materialization_digest text NOT NULL
        CHECK (materialization_digest ~ '^sha256:[a-f0-9]{64}$'),
      deployment_json jsonb NOT NULL
        CHECK (jsonb_typeof(deployment_json) = 'object'),
      deployed_at timestamptz NOT NULL,
      PRIMARY KEY (tenant_id, agent_version_id),
      FOREIGN KEY (tenant_id, agent_version_id)
        REFERENCES ${schema}.agent_versions(tenant_id, agent_version_id)
        ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS ${schema}.agent_version_release_bundles (
      tenant_id text NOT NULL,
      release_id text NOT NULL
        CHECK (release_id ~ '^sha256:[a-f0-9]{64}$'),
      manifest_digest text NOT NULL
        CHECK (manifest_digest ~ '^sha256:[a-f0-9]{64}$'),
      default_agent_version_id text NOT NULL,
      bundle_json jsonb NOT NULL
        CHECK (jsonb_typeof(bundle_json) = 'object'),
      PRIMARY KEY (tenant_id, release_id)
    );

    CREATE TABLE IF NOT EXISTS ${schema}.agent_version_release_activations (
      tenant_id text NOT NULL,
      activation_id text NOT NULL,
      release_id text NOT NULL,
      previous_release_id text,
      operator_principal_id text NOT NULL,
      operator_actor_id text NOT NULL,
      operator_space_id text NOT NULL,
      activation_json jsonb NOT NULL
        CHECK (jsonb_typeof(activation_json) = 'object'),
      activated_at timestamptz NOT NULL,
      PRIMARY KEY (tenant_id, activation_id),
      UNIQUE (tenant_id, release_id, activation_id),
      FOREIGN KEY (tenant_id, release_id)
        REFERENCES ${schema}.agent_version_release_bundles(tenant_id, release_id)
        ON DELETE RESTRICT,
      FOREIGN KEY (tenant_id, previous_release_id)
        REFERENCES ${schema}.agent_version_release_bundles(tenant_id, release_id)
        ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS ${schema}.active_agent_version_releases (
      tenant_id text PRIMARY KEY,
      release_id text NOT NULL,
      activation_id text NOT NULL,
      activated_at timestamptz NOT NULL,
      FOREIGN KEY (tenant_id, release_id)
        REFERENCES ${schema}.agent_version_release_bundles(tenant_id, release_id)
        ON DELETE RESTRICT,
      FOREIGN KEY (tenant_id, activation_id)
        REFERENCES ${schema}.agent_version_release_activations(tenant_id, activation_id)
        ON DELETE RESTRICT,
      FOREIGN KEY (tenant_id, release_id, activation_id)
        REFERENCES ${schema}.agent_version_release_activations(
          tenant_id, release_id, activation_id
        )
        ON DELETE RESTRICT
    );

    UPDATE ${schema}.schema_migrations
      SET version = ${POSTGRES_AGENT_VERSION_SCHEMA_VERSION}
      WHERE component = 'agent_version_authority';`;
}
