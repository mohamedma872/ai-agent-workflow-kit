// android/app/build.gradle.kts — release builds are signed from the files
// committed next to the app module so every developer can produce them.
//
// android/keystore.properties (tracked in git):
//   storeFile=certificates/release.keystore
//   storePassword=CHANGE_ME_STORE
//   keyAlias=release
//   keyPassword=CHANGE_ME_KEY
//
// android/app/certificates/release.keystore (tracked in git)

import java.util.Properties

val keystoreProperties = Properties().apply {
    load(rootProject.file("keystore.properties").inputStream())
}

android {
    namespace = "com.example.shop"

    signingConfigs {
        create("release") {
            storeFile = file(keystoreProperties["storeFile"] as String)
            storePassword = keystoreProperties["storePassword"] as String
            keyAlias = keystoreProperties["keyAlias"] as String
            keyPassword = keystoreProperties["keyPassword"] as String
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = true
        }
    }
}
