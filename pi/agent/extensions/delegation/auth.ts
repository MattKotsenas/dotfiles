import type { CredentialStore, Provider } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, type ProviderConfig, VERSION } from "@earendil-works/pi-coding-agent";

type Headers = Pick<ProviderConfig, "headers" | "authHeader">;
type AuthConfig = Headers & Pick<ProviderConfig, "apiKey" | "oauth">;
type Config = { getProvider(id: string): (Headers & { apiKey?: string }) | undefined };
// These interfaces describe the private layout checked by privateFields().
interface RegistryInternals {
  runtime: ModelRuntime;
  credentialStore?: CredentialStore;
}
interface CompositionInputs {
  config: Config;
  builtins: Map<string, Provider>;
  nativeExtensionProviders: Map<string, Provider>;
  extensionProviders: Map<string, AuthConfig>;
  compositionErrors: Map<string, string>;
}
interface RuntimeInternals extends CompositionInputs {
  credentials: CredentialStore;
  composeProvider(this: CompositionInputs, id: string): Provider | undefined;
}

function unsupported(): never {
  throw new Error(
    `Delegation auth requires a tested Pi 1.5.2, 1.6.1, or 1.7.0 layout and a fresh, separate child runtime (running ${VERSION})`,
  );
}

function privateFields(owner: ModelRegistry): RegistryInternals;
function privateFields(owner: ModelRuntime): RuntimeInternals;
function privateFields(owner: ModelRegistry | ModelRuntime): RegistryInternals | RuntimeInternals {
  if (VERSION !== "1.5.2" && VERSION !== "1.6.1" && VERSION !== "1.7.0") unsupported();
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
      !(fields.nativeExtensionProviders instanceof Map) ||
      !(fields.extensionProviders instanceof Map) ||
      !(fields.compositionErrors instanceof Map) ||
      typeof fields.composeProvider !== "function"
    )
      unsupported();
    return fields;
  }
  unsupported();
}

// The portable executable has no standalone provider-composer module. Invoke the
// runtime's composer with isolated inputs so neither live runtime is modified.
function composeAuth(
  composeProvider: RuntimeInternals["composeProvider"],
  id: string,
  base: Provider | undefined,
  config: Config,
  extension: AuthConfig | undefined,
): Provider["auth"] {
  const compositionErrors = new Map<string, string>();
  const emptyModels = { getModels: () => [], getAllModels: () => [] };
  const provider = composeProvider.call(
    {
      config,
      builtins: new Map(base ? [[id, { ...base, ...emptyModels }]] : []),
      nativeExtensionProviders: new Map(),
      extensionProviders: new Map(extension ? [[id, extension]] : []),
      compositionErrors,
    },
    id,
  );
  const error = compositionErrors.get(id);
  if (error || !provider) throw new Error(error ?? `Could not compose auth for ${id}`);
  return provider.auth;
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
  const runtimeComposer = fields.composeProvider;
  const compose = runtimeComposer.bind(fields);
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
    return composeAuth(
      runtimeComposer,
      id,
      base,
      { getProvider: () => ({ apiKey: config?.apiKey, headers: {} }) },
      extension && { apiKey: extension.apiKey, oauth: extension.oauth },
    );
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
        const auth = composeAuth(
          runtimeComposer,
          id,
          { ...provider, auth: inherited },
          { getProvider: () => headers(fields.config.getProvider(id)) },
          headers(child.getRegisteredProviderConfig(id)),
        );
        // The composer supplies a generic prompt otherwise; preserve unsupported login.
        if (auth.apiKey) auth.apiKey.login = inherited.apiKey?.login;
        return auth;
      },
    };
  };
}
