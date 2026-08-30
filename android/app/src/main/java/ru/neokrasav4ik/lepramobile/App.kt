package ru.neokrasav4ik.lepramobile

import android.app.Application

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Diag.fact("приложение", "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
        Diag.fact("сборка", if (BuildConfig.DEBUG) "отладочная" else "релизная")
        Diag.log("запуск")
    }
}
