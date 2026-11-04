import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Notifications from "expo-notifications";
import { Stack, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { routeForNotification } from "../src/lib/notifications";
import { SessionProvider } from "../src/session";
import { useTheme } from "../src/theme";

/** Tapping a sale or alert push opens that site's overview (also when it launched the app). */
function useNotificationRouting() {
  const router = useRouter();
  const last = Notifications.useLastNotificationResponse();
  useEffect(() => {
    const route = routeForNotification(last?.notification.request.content.data);
    if (route) router.push(route as never);
  }, [last, router]);
}

function Navigator() {
  const t = useTheme();
  useNotificationRouting();
  return (
    <>
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: t.surface },
          headerTintColor: t.text,
          contentStyle: { backgroundColor: t.bg },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="sign-in" options={{ title: "Sign in", headerBackVisible: false }} />
        <Stack.Screen name="sites" options={{ title: "Websites", headerBackVisible: false }} />
        <Stack.Screen name="site/[id]" options={{ title: "" }} />
        <Stack.Screen name="settings" options={{ title: "Settings" }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
      }),
  );
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={client}>
        <SessionProvider>
          <Navigator />
        </SessionProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
