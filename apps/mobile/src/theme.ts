import { useColorScheme } from "react-native";

export interface Theme {
  bg: string;
  surface: string;
  surface2: string;
  text: string;
  muted: string;
  line: string;
  primary: string;
  primaryText: string;
  visitors: string;
  revenue: string;
  good: string;
  bad: string;
}

const dark: Theme = {
  bg: "#0b0d12",
  surface: "#141821",
  surface2: "#1c2230",
  text: "#f2f4f8",
  muted: "#9aa3b2",
  line: "#2a3142",
  primary: "#e8a33d",
  primaryText: "#16120a",
  visitors: "#7aa7ff",
  revenue: "#e8a33d",
  good: "#4fd18b",
  bad: "#ff7a7a",
};

const light: Theme = {
  bg: "#f6f7f9",
  surface: "#ffffff",
  surface2: "#eef1f5",
  text: "#11151c",
  muted: "#5b6472",
  line: "#dde2ea",
  primary: "#b9761a",
  primaryText: "#ffffff",
  visitors: "#2f63d8",
  revenue: "#b9761a",
  good: "#14824b",
  bad: "#c62f2f",
};

export function useTheme(): Theme {
  return useColorScheme() === "light" ? light : dark;
}
