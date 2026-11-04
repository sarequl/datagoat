import { Redirect } from "expo-router";
import { Loading } from "../src/components/ui";
import { useSession } from "../src/session";

export default function Index() {
  const { state } = useSession();
  if (state.status === "loading") return <Loading />;
  return <Redirect href={state.status === "signedIn" ? "/sites" : "/sign-in"} />;
}
