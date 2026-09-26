package com.example.app.net

import android.util.Log
import okhttp3.Interceptor
import okhttp3.Response

class AuthInterceptor(private val session: SessionStore) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val token = session.accessToken
        Log.d("AuthInterceptor", "Authorization: Bearer $token for ${chain.request().url}")
        val request = chain.request().newBuilder()
            .header("Authorization", "Bearer $token")
            .build()
        val response = chain.proceed(request)
        if (response.code == 401) {
            Log.w("AuthInterceptor", "401 with refresh=${session.refreshToken}")
        }
        return response
    }
}
