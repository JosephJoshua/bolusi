// Shell root component — real navigation/screens land with task 24 (app-shell).
// Deliberately renders no text: user-visible strings only enter through the
// @bolusi/i18n label catalog (bolusi/no-hardcoded-strings, 07-i18n).
import { StatusBar } from 'expo-status-bar';
import { View } from 'react-native';

export default function App() {
  return (
    <View testID="bolusi-app-shell" style={{ flex: 1 }}>
      <StatusBar style="auto" />
    </View>
  );
}
