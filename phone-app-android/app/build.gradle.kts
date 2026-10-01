plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}
android {
    namespace = "com.presenter.remote"
    compileSdk = 34
    defaultConfig {
        applicationId = "com.presenter.remote"
        minSdk = 24
        targetSdk = 34
        versionCode = 3
        versionName = "1.2"
    }
    // Fixed signing key so every GitHub build installs over the previous one.
    signingConfigs {
        getByName("debug") {
            storeFile = file("debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }
    // The build distributed to phones: shrunk and obfuscated (harder to read if someone
    // decompiles the APK), still signed with the key above so it installs over older versions.
    // The GitHub Action builds this one (assembleRelease).
    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    // QR scanner (Google's code scanner: no camera permission needed)
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
}
