// android/gradle.properties sets newArchEnabled=true; ios/Podfile sets RCT_NEW_ARCH_ENABLED=1.
import { NativeModules } from 'react-native';

// Legacy bridge module: no codegen spec (no NativeBiometricsSpec.ts / TurboModuleRegistry),
// the native side still extends ReactContextBaseJavaModule / RCTBridgeModule only.
const { BiometricsModule } = NativeModules;

export async function authenticate(reason: string): Promise<boolean> {
  return BiometricsModule.authenticate(reason);
}

export function isAvailable(): boolean {
  // synchronous bridge call — blocks the JS thread on the legacy bridge
  return BiometricsModule.isAvailableSync();
}
