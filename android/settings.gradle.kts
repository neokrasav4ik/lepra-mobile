/* Оправа вокруг lepra-mobile.user.js: одно окно, один модуль.

   Скрипт лежит НЕ здесь, а в корне репозитория — он общий для трёх сред
   (Safari, Firefox, это приложение), и второй копии у него быть не должно.
   Сборка забирает его оттуда: см. copyUserScript в app/build.gradle.kts. */

pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "LepraMobile"
include(":app")
