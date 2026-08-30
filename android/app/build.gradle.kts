import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

/* ---------------------------------------------------------------------------
   СКРИПТ БЕРЁТСЯ ИЗ КОРНЯ РЕПОЗИТОРИЯ, А НЕ ЛЕЖИТ КОПИЕЙ В assets.

   Главное правило проекта: lepra-mobile.user.js существует в одном
   экземпляре. Вторая копия рассинхронизируется в первую же неделю, а
   расхождение вылезет через месяц как «в приложении почему-то по-другому».

   Поэтому assets собираются задачей: файл копируется при каждой сборке из
   ../../lepra-mobile.user.js. Обновил скрипт — следующая сборка взяла новый,
   и сделать иначе нельзя даже по забывчивости.

   Если файла нет — сборка падает СРАЗУ и с внятным словом. Молчаливое
   «собралось, но скрипта внутри нет» дало бы приложение, показывающее
   десктопную лепру под лупой, и искать причину пришлось бы на устройстве.
--------------------------------------------------------------------------- */
val scriptFile = rootProject.file("../lepra-mobile.user.js")
val generatedAssets = layout.buildDirectory.dir("generated/userscript")

val copyUserScript = tasks.register<Copy>("copyUserScript") {
    doFirst {
        if (!scriptFile.exists())
            throw GradleException(
                "Не найден скрипт: ${scriptFile.absolutePath}\n" +
                "Он обязан лежать в корне репозитория рядом с папкой android/."
            )
        if (scriptFile.length() < 100_000)
            throw GradleException(
                "Скрипт подозрительно мал (${scriptFile.length()} байт). " +
                "Похоже, это не он."
            )
    }
    from(scriptFile)
    into(generatedAssets)
}

/* Ключ подписи. Пути и пароли приходят снаружи — из переменных окружения
   (так их задаёт GitHub Actions) или из keystore.properties рядом с проектом
   (так удобнее на своей машине). В репозиторий не попадает ни то, ни другое.

   Ключ ОДИН на всю жизнь приложения. Потеряешь — следующая версия не встанет
   поверх предыдущей, и человеку придётся сносить приложение вместе с сессией. */
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

fun secret(name: String, prop: String): String? =
    System.getenv(name) ?: keystoreProps.getProperty(prop)

val storePath = secret("LEPRA_KEYSTORE", "storeFile")
val storePass = secret("LEPRA_KEYSTORE_PASSWORD", "storePassword")
val keyName = secret("LEPRA_KEY_ALIAS", "keyAlias")
val keyPass = secret("LEPRA_KEY_PASSWORD", "keyPassword")
val haveKey = !storePath.isNullOrBlank() && file(storePath!!).exists()

android {
    namespace = "ru.neokrasav4ik.lepramobile"
    compileSdk = 36

    defaultConfig {
        applicationId = "ru.neokrasav4ik.lepramobile"
        minSdk = 26
        targetSdk = 36
        versionCode = 4
        versionName = "0.1.3"
    }

    signingConfigs {
        if (haveKey) {
            create("release") {
                storeFile = file(storePath!!)
                storePassword = storePass
                keyAlias = keyName
                keyPassword = keyPass
            }
        }
    }

    buildTypes {
        release {
            /* Сжатие кода выключено намеренно. Выигрыш — сотня килобайт на
               приложении, где вся работа в WebView, а цена — правила
               сохранения для отражения (ScriptStore зовёт androidx.webkit
               по имени метода) и класс ошибок, которых нет в отладочной
               сборке. Не та сделка. */
            isMinifyEnabled = false
            isShrinkResources = false
            signingConfig = if (haveKey) signingConfigs.getByName("release") else null
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    sourceSets["main"].assets.srcDir(generatedAssets)

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
        /* Часть androidx.webkit какое-то время была помечена как
           «экспериментальная»: без этого согласия сборка падала бы на
           addDocumentStartJavaScript. Если в нашей версии пометки уже нет —
           строка ничего не делает и даёт лишь предупреждение. */
        freeCompilerArgs = freeCompilerArgs + listOf(
            "-opt-in=androidx.webkit.ExperimentalWebViewApi"
        )
    }
    buildFeatures {
        buildConfig = true
    }
    packaging {
        /* Скрипт — 1,7 МБ текста; жать его в APK обязательно. */
        resources.excludes += setOf("META-INF/*.version")
    }
}

tasks.named("preBuild") { dependsOn(copyUserScript) }

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.1.0")
    /* Ради addDocumentStartJavaScript — впрыска до разбора разметки и во все
       подходящие окна. Ничего другого из этой библиотеки нам не нужно. */
    implementation("androidx.webkit:webkit:1.14.0")
}
