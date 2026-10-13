package com.example.shop.session

import android.content.Context
import android.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/// Encrypts the refresh token before it is written to SharedPreferences.
class SessionCrypto(context: Context) {
    private val prefs = context.getSharedPreferences("session", Context.MODE_PRIVATE)

    private fun key(): SecretKey {
        val stored = prefs.getString("aes_key", null)
        if (stored != null) return SecretKeySpec(Base64.decode(stored, Base64.NO_WRAP), "AES")
        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        prefs.edit().putString("aes_key", Base64.encodeToString(key.encoded, Base64.NO_WRAP)).apply()
        return key
    }

    fun saveRefreshToken(token: String) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val sealed = cipher.iv + cipher.doFinal(token.toByteArray())
        prefs.edit().putString("refresh_token", Base64.encodeToString(sealed, Base64.NO_WRAP)).apply()
    }

    fun refreshToken(): String? {
        val sealed = prefs.getString("refresh_token", null)?.let { Base64.decode(it, Base64.NO_WRAP) } ?: return null
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            .apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, sealed.copyOfRange(0, 12))) }
        return String(cipher.doFinal(sealed.copyOfRange(12, sealed.size)))
    }
}
