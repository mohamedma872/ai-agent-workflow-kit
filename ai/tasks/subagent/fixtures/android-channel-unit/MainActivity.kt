package com.example.shop

import android.content.Intent
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.EventChannel

// Exported, launchMode="singleTask"; forwards links that arrive while the app runs.
class MainActivity : FlutterActivity() {
    private var linkSink: EventChannel.EventSink? = null
    private var pendingLink: String? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        EventChannel(flutterEngine.dartExecutor.binaryMessenger, "shop/links")
            .setStreamHandler(object : EventChannel.StreamHandler {
                override fun onListen(args: Any?, events: EventChannel.EventSink) {
                    linkSink = events
                    pendingLink?.let { events.success(it); pendingLink = null }
                }
                override fun onCancel(args: Any?) { linkSink = null }
            })
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (intent.action == Intent.ACTION_VIEW) {
            val events = linkSink
            if (events == null) {
                pendingLink = intent.dataString // delivered in onListen
                return
            }
            val link = intent.dataString ?: events.error("NO_DATA", "link without data", null)
            events.success(link)
        }
    }
}
