package com.example.shop.checkout

import android.content.Context
import android.view.View
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.platform.PlatformView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class CardFormView(context: Context, messenger: BinaryMessenger) : PlatformView {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val channel = MethodChannel(messenger, "shop/card_form")
    private val form = CardFormComponent(context)

    init {
        channel.setMethodCallHandler { call, result ->
            when (call.method) {
                "isValid" -> scope.launch {
                    val valid = try {
                        withContext(Dispatchers.IO) { form.validate() } // suspends on a network BIN lookup
                    } catch (e: Exception) {
                        false
                    }
                    withContext(Dispatchers.Main) { result.success(valid) }
                }
                else -> result.notImplemented()
            }
        }
    }

    override fun getView(): View = form.view

    // The Dart Pay button awaits invokeMethod('isValid') with no timeout.
    override fun dispose() {
        scope.cancel()
        channel.setMethodCallHandler(null)
    }
}
