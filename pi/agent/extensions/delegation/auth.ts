import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CredentialStore, Provider } from "@earendil-works/pi-ai";
import {
  getPackageDir,
  ModelRegistry,
  ModelRuntime,
  VERSION,
  type ProviderConfig,
} from "@earendil-works/pi-coding-agent";

type Headers = Pick<ProviderConfig, "headers" | "authHeader">;
type AuthConfig = Headers & Pick<ProviderConfig, "apiKey" | "oauth">;
type Config = { getProvider(id: string): (Headers & { apiKey?: string }) | undefined };
// These interfaces describe the private layout checked by privateFields().
interface RegistryInternals {
  runtime: ModelRuntime;
  credentialStore?: CredentialStore;
}
interface RuntimeInternals {
  credentials: CredentialStore;
  config: Config;
  builtins: Map<string, Provider>;
  composeProvider(id: string): Provider | undefined;
}
type Compose = (id: string, base: Provider | undefined, config: Config, extension: AuthConfig | undefined) => Provider;

function unsupported(): never {
  throw new Error(
    `Delegation auth requires the tested Pi 1.2.0 layout and a fresh, separate child runtime (running ${VERSION})`,
  );
}

function privateFields(owner: ModelRegistry): RegistryInternals;
function privateFields(owner: ModelRuntime): RuntimeInternals;
function privateFields(owner: ModelRegistry | ModelRuntime): RegistryInternals | RuntimeInternals {
  if (VERSION !== "1.2.0") unsupported();
  if (owner instanceof ModelRegistry) {
    const fields = owner as unknown as RegistryInternals;
    if (!(fields.runtime instanceof ModelRuntime)) unsupported();
    return fields;
  }
  if (owner instanceof ModelRuntime) {
    const fields = owner as unknown as RuntimeInternals;
    if (
      typeof fields.config?.getProvider !== "function" ||
      !(fields.builtins instanceof Map) ||
      typeof fields.composeProvider !== "function"
    )
      unsupported();
    return fields;
  }
  unsupported();
}

async function providerComposer(): Promise<Compose> {
  const { composeModelProvider } = await import(
    pathToFileURL(join(getPackageDir(), "dist/core/provider-composer.js")).href
  );
  if (typeof composeModelProvider !== "function") unsupported();
  return composeModelProvider;
}

export function getParentCredentials(parent: ModelRegistry): CredentialStore {
  const registry = privateFields(parent);
  const fields = privateFields(registry.runtime);
  const store = "credentialStore" in parent ? registry.credentialStore : fields.credentials;
  if (
    !store ||
    typeof store.read !== "function" ||
    typeof store.list !== "function" ||
    typeof store.modify !== "function" ||
    typeof store.delete !== "function"
  )
    unsupported();
  return store;
}

// Install on a fresh child before createAgentSession replays provider registrations.
export async function inheritParentAuth(child: ModelRuntime, parent: ModelRegistry): Promise<void> {
  const runtime = privateFields(parent).runtime;
  const parentFields = privateFields(runtime);
  const fields = privateFields(child);
  if (child === runtime || Object.hasOwn(child, "composeProvider")) unsupported();
  const composeModelProvider = await providerComposer();
  const compose = fields.composeProvider.bind(child);
  const emptyModels = { getModels: () => [], getAllModels: () => [] };
  const headers = (config: Headers | undefined): Headers => ({
    headers: config?.headers ?? {},
    authHeader: config?.authHeader,
  });
  function parentAuth(id: string): Provider["auth"] | undefined {
    const base = runtime.getRegisteredNativeProvider(id) ?? parentFields.builtins.get(id);
    const config = parentFields.config.getProvider(id);
    const extension = runtime.getRegisteredProviderConfig(id);
    if (!config && !extension) return base?.auth;
    // Parent configuration headers cannot be separated from auth-derived headers
    // after resolution. Compose only the parent's auth settings here.
    return composeModelProvider(
      id,
      base && { ...base, ...emptyModels },
      { getProvider: () => ({ apiKey: config?.apiKey, headers: {} }) },
      extension && { apiKey: extension.apiKey, oauth: extension.oauth },
    ).auth;
  }
  fields.composeProvider = (id) => {
    const provider = compose(id);
    if (!provider) return provider;
    return {
      ...provider,
      get auth() {
        const inherited = parentAuth(id);
        if (!inherited)
          return {
            apiKey: { name: "Unavailable parent auth", check: async () => undefined, resolve: async () => undefined },
          };
        const auth = composeModelProvider(
          id,
          { ...provider, ...emptyModels, auth: inherited },
          { getProvider: () => headers(fields.config.getProvider(id)) },
          headers(child.getRegisteredProviderConfig(id)),
        ).auth;
        // The composer supplies a generic prompt otherwise; preserve unsupported login.
        if (auth.apiKey) auth.apiKey.login = inherited.apiKey?.login;
        return auth;
      },
    };
  };
}
