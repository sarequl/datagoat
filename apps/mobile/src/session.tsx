/**
 * Signed-in state: instance URL + mobile token in the device keychain (expo-secure-store).
 */
import * as Device from "expo-device";
import * as SecureStore from "expo-secure-store";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  type Api,
  ApiError,
  signIn as apiSignIn,
  createApi,
  type User,
  type WebsiteSummary,
} from "./lib/api";

const KEY_INSTANCE = "datagoat.instance";
const KEY_TOKEN = "datagoat.token";
const KEY_USER = "datagoat.user";
export const KEY_DEVICE = "datagoat.device";

type State =
  | { status: "loading" }
  | { status: "signedOut" }
  | { status: "signedIn"; instanceUrl: string; token: string; user: User | null };

export interface Session {
  state: State;
  api: Api | null;
  signIn(instanceUrl: string, email: string, password: string): Promise<WebsiteSummary[]>;
  signOut(): Promise<void>;
  /** Call when a request answers 401: the token was revoked or expired. */
  handleAuthError(err: unknown): boolean;
}

const Context = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    (async () => {
      const [instanceUrl, token, user] = await Promise.all([
        SecureStore.getItemAsync(KEY_INSTANCE),
        SecureStore.getItemAsync(KEY_TOKEN),
        SecureStore.getItemAsync(KEY_USER),
      ]);
      if (instanceUrl && token) {
        setState({
          status: "signedIn",
          instanceUrl,
          token,
          user: user ? (JSON.parse(user) as User) : null,
        });
      } else {
        setState({ status: "signedOut" });
      }
    })().catch(() => setState({ status: "signedOut" }));
  }, []);

  const api = useMemo(
    () => (state.status === "signedIn" ? createApi(fetch, state.instanceUrl, state.token) : null),
    [state],
  );

  const clear = useCallback(async () => {
    await Promise.all(
      [KEY_INSTANCE, KEY_TOKEN, KEY_USER, KEY_DEVICE].map((k) => SecureStore.deleteItemAsync(k)),
    );
    setState({ status: "signedOut" });
  }, []);

  const signIn = useCallback(async (instanceUrl: string, email: string, password: string) => {
    const session = await apiSignIn(
      fetch,
      instanceUrl,
      email,
      password,
      Device.deviceName ?? undefined,
    );
    await Promise.all([
      SecureStore.setItemAsync(KEY_INSTANCE, instanceUrl),
      SecureStore.setItemAsync(KEY_TOKEN, session.token),
      SecureStore.setItemAsync(KEY_USER, JSON.stringify(session.user)),
    ]);
    setState({ status: "signedIn", instanceUrl, token: session.token, user: session.user });
    return session.websites;
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api?.signOut();
    } catch {
      // Offline or already revoked: forget the token locally anyway.
    }
    await clear();
  }, [api, clear]);

  const handleAuthError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.isAuth) {
        void clear();
        return true;
      }
      return false;
    },
    [clear],
  );

  const value = useMemo<Session>(
    () => ({ state, api, signIn, signOut, handleAuthError }),
    [state, api, signIn, signOut, handleAuthError],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useSession(): Session {
  const value = useContext(Context);
  if (!value) throw new Error("useSession() outside SessionProvider");
  return value;
}

/** The API client of a signed-in session (screens behind the sign-in redirect). */
export function useApi(): Api {
  const { api } = useSession();
  if (!api) throw new Error("useApi() while signed out");
  return api;
}
