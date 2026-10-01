package com.example.app.help

import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity

class HelpActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val web = WebView(this)
        setContentView(web)
        web.settings.javaScriptEnabled = true
        web.addJavascriptInterface(AccountBridge(this), "Account")
        // opened from push notifications and from the example://help?page=<url> deep link
        val page = intent.getStringExtra("page") ?: "https://help.example.com"
        web.loadUrl(page)
    }
}

class AccountBridge(private val activity: HelpActivity) {
    @JavascriptInterface
    fun sessionToken(): String = SessionStore.get(activity).accessToken

    @JavascriptInterface
    fun email(): String = SessionStore.get(activity).email
}
