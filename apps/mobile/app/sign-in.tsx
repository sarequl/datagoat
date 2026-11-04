import { useRouter } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { normalizeInstanceUrl } from "../src/lib/api";
import { useSession } from "../src/session";
import { useTheme } from "../src/theme";

export default function SignIn() {
  const t = useTheme();
  const router = useRouter();
  const { signIn } = useSession();
  const [instance, setInstance] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    const url = normalizeInstanceUrl(instance);
    if (!url) {
      setError("Enter your DataGoat address, e.g. analytics.example.com (https).");
      return;
    }
    if (!email.includes("@") || !password) {
      setError("Enter your email and password.");
      return;
    }
    setBusy(true);
    try {
      await signIn(url, email.trim().toLowerCase(), password);
      router.replace("/sites");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const input = [styles.input, { color: t.text, backgroundColor: t.surface, borderColor: t.line }];
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={{ flex: 1 }}
    >
      <ScrollView contentContainerStyle={styles.wrap} keyboardShouldPersistTaps="handled">
        <Text style={[styles.title, { color: t.text }]}>DataGoat</Text>
        <Text style={{ color: t.muted, marginBottom: 24 }}>
          Sign in to your DataGoat instance with your dashboard email and password.
        </Text>
        <Text style={[styles.label, { color: t.muted }]}>DataGoat address</Text>
        <TextInput
          style={input}
          value={instance}
          onChangeText={setInstance}
          placeholder="analytics.example.com"
          placeholderTextColor={t.muted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          textContentType="URL"
        />
        <Text style={[styles.label, { color: t.muted }]}>Email</Text>
        <TextInput
          style={input}
          value={email}
          onChangeText={setEmail}
          placeholder="you@example.com"
          placeholderTextColor={t.muted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          textContentType="username"
        />
        <Text style={[styles.label, { color: t.muted }]}>Password</Text>
        <TextInput
          style={input}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          textContentType="password"
          onSubmitEditing={submit}
        />
        {error ? <Text style={{ color: t.bad, marginTop: 12 }}>{error}</Text> : null}
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={submit}
          style={[styles.button, { backgroundColor: t.primary, opacity: busy ? 0.7 : 1 }]}
        >
          {busy ? (
            <ActivityIndicator color={t.primaryText} />
          ) : (
            <Text style={{ color: t.primaryText, fontWeight: "700" }}>Sign in</Text>
          )}
        </Pressable>
        <View style={{ height: 24 }} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: 24, paddingTop: 48 },
  title: { fontSize: 30, fontWeight: "800", marginBottom: 6 },
  label: { fontSize: 13, marginTop: 14, marginBottom: 6 },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 16,
  },
  button: { marginTop: 24, borderRadius: 10, paddingVertical: 14, alignItems: "center" },
});
