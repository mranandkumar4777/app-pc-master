package com.presenter.remote

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.NetworkInterface
import java.net.URL
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * Presenter Remote: a thin native shell around the /remote page that server.js serves.
 * Adds what a browser tab can't: a saved address, screen kept awake, and volume keys
 * for Next / Prev.
 */
class MainActivity : Activity() {
    private val bg = Color.parseColor("#16140F")
    private val gold = Color.parseColor("#C9A227")
    private val dim = Color.parseColor("#A79E8A")

    // ---- update check -------------------------------------------------------
    // Points at a small JSON file the GitHub Action keeps up to date on every push:
    //   {"versionCode":4,"versionName":"1.3","url":"https://...apk","notes":"..."}
    // Replace OWNER/REPO with your GitHub username/repository. Until then this is left
    // unset on purpose and the check quietly does nothing. See DISTRIBUTION-AND-UPDATES.md.
    private val UPDATE_INFO_URL = "https://github.com/OWNER/REPO/releases/latest/download/version.json"

    private lateinit var web: WebView
    private lateinit var settingsBtn: Button
    private lateinit var panel: LinearLayout
    private lateinit var address: EditText
    private lateinit var password: EditText
    private lateinit var error: TextView
    private var onRemote = false
    private var searching = false
    private lateinit var status: TextView
    private lateinit var foundBox: LinearLayout
    private lateinit var searchBtn: Button
    private var netCallback: ConnectivityManager.NetworkCallback? = null

    private class Found(val host: String, val port: Int, val name: String)
    private class PairResult(val status: String, val pin: String? = null)

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
    private val prefs get() = getSharedPreferences("remote", MODE_PRIVATE)

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        window.statusBarColor = bg
        window.navigationBarColor = bg
        val match = ViewGroup.LayoutParams.MATCH_PARENT

        web = WebView(this).apply {
            setBackgroundColor(bg)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true // the page remembers the PIN here
            // Tells the computer which phone this is, so it shows up by name in Presenter (📱 Phone) and can be removed there.
            settings.userAgentString = settings.userAgentString + " PresenterRemoteApp id=" + deviceId() + " name=" + Uri.encode(deviceName())
            webViewClient = object : WebViewClient() {
                override fun onReceivedError(view: WebView, request: WebResourceRequest, err: WebResourceError) {
                    if (request.isForMainFrame) {
                        showConnect("Couldn't reach that computer. Check Presenter is running and that you're on the same Wi-Fi or Tailscale is connected on both.", true)
                    }
                }
            }
        }

        fun label(t: String, size: Float, c: Int) = TextView(this).apply {
            text = t; textSize = size; setTextColor(c)
        }
        address = EditText(this).apply {
            hint = "Tailscale address, e.g. 100.101.102.103"
            setHintTextColor(dim)
            setTextColor(Color.WHITE)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            imeOptions = EditorInfo.IME_ACTION_GO
            setSingleLine()
            setOnEditorActionListener { _, _, _ -> manualConnect(); true }
        }
        password = EditText(this).apply {
            hint = "Connection PIN (4-64 characters)"
            setHintTextColor(dim)
            setTextColor(Color.WHITE)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            imeOptions = EditorInfo.IME_ACTION_GO
            setSingleLine()
            setOnEditorActionListener { _, _, _ -> manualConnect(); true }
        }
        error = label("", 14f, Color.parseColor("#E0796A")).apply { setPadding(0, dp(14), 0, 0) }
        val connect = Button(this).apply {
            text = "Connect"
            isAllCaps = false
            setTextColor(bg)
            setBackgroundColor(gold)
            setOnClickListener { manualConnect() }
        }
        status = label("", 16f, Color.WHITE).apply { setPadding(0, dp(8), 0, dp(12)) }
        foundBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        searchBtn = Button(this).apply {
            text = "Search again"
            isAllCaps = false
            visibility = View.GONE
            setOnClickListener { startDiscovery() }
        }
        val scanBtn = Button(this).apply {
            text = "Scan QR code"
            isAllCaps = false
            textSize = 18f
            setTextColor(bg)
            setBackgroundColor(gold)
            setOnClickListener { scanQr() }
        }
        panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(bg)
            setPadding(dp(28), dp(28), dp(28), dp(28))
            addView(label("Presenter Remote", 24f, Color.WHITE))
            addView(scanBtn, LinearLayout.LayoutParams(match, dp(64)).apply { topMargin = dp(18) })
            addView(label("On the computer: Presenter → 📱 Phone, then scan the code.", 13f, dim).apply { setPadding(0, dp(8), 0, dp(4)) })
            addView(status)
            addView(foundBox)
            addView(searchBtn, LinearLayout.LayoutParams(match, ViewGroup.LayoutParams.WRAP_CONTENT))
            addView(label("Or connect from any network (Tailscale on both): computer address and the connection PIN. The PIN is set on the computer (Presenter → Settings → PINs); this app can only enter it.", 13f, dim).apply { setPadding(0, dp(28), 0, dp(6)) })
            addView(address)
            addView(password)
            addView(connect, LinearLayout.LayoutParams(match, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(12) })
            addView(error)
        }

        settingsBtn = Button(this).apply {
            text = "⚙"
            textSize = 20f
            isAllCaps = false
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.parseColor("#80000000"))
            visibility = View.GONE
            setOnClickListener { showSettings() }
        }

        setContentView(FrameLayout(this).apply {
            setBackgroundColor(bg)
            addView(web, FrameLayout.LayoutParams(match, match))
            addView(panel, FrameLayout.LayoutParams(match, match))
            addView(settingsBtn, FrameLayout.LayoutParams(dp(44), dp(44)).apply {
                gravity = Gravity.TOP or Gravity.END
                topMargin = dp(14)
                rightMargin = dp(14)
            })
        })

        checkForUpdate(announceIfCurrent = false)

        val fromLink = intent?.data?.toString()
        val saved = prefs.getString("addr", null)
        when {
            fromLink != null -> open(fromLink)
            saved != null -> { applyBinding(saved.substringBefore(':')); reconnect(saved) }
            else -> { applyBinding(""); showConnect(null, true) }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.data?.let { open(it.toString()) }
    }

    private fun showConnect(msg: String?, auto: Boolean) {
        onRemote = false
        web.visibility = View.GONE
        panel.visibility = View.VISIBLE
        settingsBtn.visibility = View.GONE
        error.text = msg ?: ""
        address.setText(prefs.getString("addr", ""))
        password.setText(prefs.getString("pin", ""))
        if (auto) {
            startDiscovery()
        } else if (!searching) {
            status.text = ""
            searchBtn.visibility = View.VISIBLE
        }
    }

    // ---- automatic connection: find the computer on the Wi-Fi, pair, open the remote ----

    private fun deviceName(): String = "${Build.MANUFACTURER} ${Build.MODEL}".trim()

    private fun deviceId(): String {
        val existing = prefs.getString("id", null)
        if (existing != null) return existing
        val fresh = UUID.randomUUID().toString()
        prefs.edit().putString("id", fresh).apply()
        return fresh
    }

    private fun localPrefixes(): List<String> {
        val out = LinkedHashSet<String>()
        try {
            val nis = NetworkInterface.getNetworkInterfaces() ?: return emptyList()
            for (ni in java.util.Collections.list(nis)) {
                if (!ni.isUp || ni.isLoopback) continue
                for (ia in ni.interfaceAddresses) {
                    val a = ia.address
                    if (a is Inet4Address && a.isSiteLocalAddress) {
                        val ip = a.hostAddress ?: continue
                        out.add(ip.substringBeforeLast('.'))
                    }
                }
            }
        } catch (e: Exception) {
        }
        return out.toList()
    }

    private fun probe(host: String, port: Int, connectMs: Int, readMs: Int): Found? {
        return try {
            val c = URL("http://$host:$port/api/hello").openConnection() as HttpURLConnection
            c.connectTimeout = connectMs
            c.readTimeout = readMs
            c.requestMethod = "GET"
            val body = c.inputStream.bufferedReader().use { it.readText() }
            c.disconnect()
            val j = JSONObject(body)
            if (j.optString("app") == "presenter") Found(host, port, j.optString("name", host)) else null
        } catch (e: Exception) {
            null
        }
    }

    private fun scan(): List<Found> {
        val found = ConcurrentLinkedQueue<Found>()
        val hosts = ArrayList<String>()
        prefs.getString("addr", null)?.substringBefore(':')?.let { hosts.add(it) }
        for (p in localPrefixes()) for (i in 1..254) hosts.add("$p.$i")
        val pool = Executors.newFixedThreadPool(64)
        for (h in hosts.distinct()) {
            pool.execute { probe(h, 8787, 350, 700)?.let { found.add(it) } }
        }
        pool.shutdown()
        pool.awaitTermination(20, TimeUnit.SECONDS)
        return found.toList().distinctBy { it.host }
    }

    private fun pair(f: Found): PairResult {
        return try {
            val c = URL("http://${f.host}:${f.port}/api/pair").openConnection() as HttpURLConnection
            c.connectTimeout = 3000
            c.readTimeout = 75000
            c.requestMethod = "POST"
            c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json")
            val body = JSONObject().put("device", deviceName()).put("id", deviceId())
                .put("pin", prefs.getString("pin", "") ?: "").toString()
            c.outputStream.use { it.write(body.toByteArray()) }
            val text = c.inputStream.bufferedReader().use { it.readText() }
            c.disconnect()
            val j = JSONObject(text)
            when {
                j.optBoolean("ok") -> PairResult("ok", j.optString("pin"))
                j.optBoolean("needPin") -> PairResult("needpin")
                j.optBoolean("busy") -> PairResult("busy")
                j.optBoolean("wrongPin") -> PairResult("wrongpin")
                j.optBoolean("locked") -> PairResult("locked")
                else -> PairResult("denied")
            }
        } catch (e: Exception) {
            PairResult("error")
        }
    }

    private fun startDiscovery() {
        if (searching) return
        searching = true
        status.text = "Looking for Presenter on your Wi-Fi…"
        foundBox.removeAllViews()
        searchBtn.visibility = View.GONE
        thread {
            val list = scan()
            runOnUiThread {
                searching = false
                if (isFinishing || onRemote) return@runOnUiThread
                when {
                    list.isEmpty() -> {
                        status.text = "Couldn't find Presenter. Open it on your computer and make sure both are on the same Wi-Fi."
                        searchBtn.visibility = View.VISIBLE
                    }
                    list.size == 1 -> connectTo(list[0])
                    else -> {
                        status.text = "Choose your computer:"
                        for (f in list) {
                            foundBox.addView(Button(this).apply {
                                text = "${f.name}  (${f.host})"
                                isAllCaps = false
                                setOnClickListener { connectTo(f) }
                            })
                        }
                        searchBtn.visibility = View.VISIBLE
                    }
                }
            }
        }
    }

    private fun connectTo(f: Found) {
        status.text = "Connecting to ${f.name}…\nIf a window appears on your computer, click Allow."
        foundBox.removeAllViews()
        searchBtn.visibility = View.GONE
        thread {
            val r = pair(f)
            runOnUiThread {
                if (isFinishing || onRemote) return@runOnUiThread
                when (r.status) {
                    "ok" -> open("http://${f.host}:${f.port}/remote?pin=${Uri.encode(r.pin ?: "")}")
                    "needpin" -> open("http://${f.host}:${f.port}/remote")
                    "wrongpin" -> {
                        status.text = ""
                        showConnect("Wrong PIN.", false)
                    }
                    "locked" -> {
                        status.text = ""
                        showConnect("Too many wrong PINs. Try again in 10 minutes.", false)
                    }
                    "busy" -> {
                        status.text = "Another phone is waiting for approval. Try again in a moment."
                        searchBtn.visibility = View.VISIBLE
                    }
                    "denied" -> {
                        status.text = "The computer didn't allow this phone."
                        searchBtn.visibility = View.VISIBLE
                    }
                    else -> {
                        status.text = "Lost contact with the computer. Try again."
                        searchBtn.visibility = View.VISIBLE
                    }
                }
            }
        }
    }

    private fun isLanHost(h: String): Boolean {
        val p = h.split('.').mapNotNull { it.toIntOrNull() }
        if (p.size != 4) return false
        return p[0] == 10 || (p[0] == 192 && p[1] == 168) || (p[0] == 172 && p[1] in 16..31) || (p[0] == 169 && p[1] == 254)
    }

    /** Typed address + password: works over Tailscale (or any reachable address), from any network. */
    private fun manualConnect() {
        val raw = address.text.toString().trim()
        val pw = password.text.toString().trim()
        if (raw.startsWith("http") && raw.contains("/remote")) { open(raw); return }
        val host = raw.removePrefix("http://").removePrefix("https://").substringBefore('/').substringBefore(':')
        val port = raw.substringAfter(':', "").substringBefore('/').toIntOrNull() ?: 8787
        if (host.isEmpty()) { showConnect("Enter the computer's address.", false); return }
        if (pw.length < 4 || pw.length > 64) { showConnect("Enter the connection PIN (4-64 characters) shown on the computer.", false); return }
        prefs.edit().putString("pin", pw).apply()
        applyBinding(host)
        error.text = ""
        status.text = "Connecting…"
        foundBox.removeAllViews()
        searchBtn.visibility = View.GONE
        thread {
            val f = probe(host, port, 4000, 5000)
            runOnUiThread {
                if (isFinishing || onRemote) return@runOnUiThread
                if (f == null) {
                    status.text = ""
                    showConnect("Couldn't reach $host:$port. Is Presenter running, and is Tailscale connected on both devices?", false)
                } else connectTo(f)
            }
        }
    }

    /** Re-open the last computer quickly; if it moved or is off, search the Wi-Fi again. */
    private fun reconnect(saved: String) {
        showConnect(null, false)
        status.text = "Connecting…"
        searchBtn.visibility = View.GONE
        val host = saved.substringBefore(':')
        val port = saved.substringAfter(':', "8787").toIntOrNull() ?: 8787
        thread {
            val f = probe(host, port, 1000, 1500)
            runOnUiThread {
                if (isFinishing || onRemote) return@runOnUiThread
                if (f != null) connectTo(f) else startDiscovery()
            }
        }
    }

    private fun showRemote() {
        onRemote = true
        panel.visibility = View.GONE
        web.visibility = View.VISIBLE
        settingsBtn.visibility = View.VISIBLE
    }

    /** Accepts "192.168.1.23", "192.168.1.23:8787" or a full link (the QR code: ?pin=...&alt=other,addresses). */
    private fun open(raw: String) {
        val text = raw.trim()
        val full = if (text.startsWith("http://") || text.startsWith("https://")) text else "http://$text"
        val uri = Uri.parse(full)
        val host = uri.host
        if (text.isEmpty() || host.isNullOrEmpty()) {
            showConnect("That address doesn't look right.", false)
            return
        }
        val port = if (uri.port == -1) 8787 else uri.port
        val pin = uri.getQueryParameter("pin")
        val alts = (uri.getQueryParameter("alt") ?: "").split(",").map { it.trim() }.filter { it.isNotEmpty() && it != host }
        if (alts.isEmpty()) {
            launchRemote(host, port, pin)
            return
        }
        // The QR code lists every network address of the computer: use the first one that answers.
        showConnect(null, false)
        status.text = "Connecting…"
        searchBtn.visibility = View.GONE
        thread {
            val all = listOf(host) + alts
            val ok = java.util.concurrent.ConcurrentHashMap<String, Boolean>()
            val pool = Executors.newFixedThreadPool(all.size)
            for (h in all) pool.execute {
                val f = probe(h, port, 1500, 2000)
                if (f != null) {
                    ok[h] = true
                }
            }
            pool.shutdown()
            pool.awaitTermination(6, TimeUnit.SECONDS)
            val chosen = all.firstOrNull { ok.containsKey(it) } ?: host
            runOnUiThread { if (!isFinishing) launchRemote(chosen, port, pin) }
        }
    }

    private fun launchRemote(host: String, port: Int, pin: String?) {
        applyBinding(host)
        val base = "http://$host:$port/remote"
        val ed = prefs.edit().putString("addr", "$host:$port")
        if (!pin.isNullOrEmpty()) ed.putString("pin", pin) // lets the next start reconnect without an Allow prompt
        ed.apply()
        showRemote()
        web.loadUrl(if (!pin.isNullOrEmpty()) "$base?pin=${Uri.encode(pin)}" else base)
    }

    private fun scanQr() {
        try {
            val options = GmsBarcodeScannerOptions.Builder()
                .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                .build()
            GmsBarcodeScanning.getClient(this, options).startScan()
                .addOnSuccessListener { code ->
                    val v = code.rawValue ?: ""
                    if (v.startsWith("http") && v.contains("/remote")) open(v)
                    else error.text = "That QR code isn't from Presenter."
                }
                .addOnFailureListener {
                    error.text = "Couldn't open the scanner. Scan with your camera app instead, or type the address."
                }
        } catch (e: Exception) {
            error.text = "Couldn't open the scanner. Scan with your camera app instead, or type the address."
        }
    }

    /** Keep traffic on the Wi-Fi only for local (LAN) addresses or while searching; Tailscale/public addresses use the normal route so any network works. */
    private fun applyBinding(host: String) {
        val cm = getSystemService(CONNECTIVITY_SERVICE) as ConnectivityManager
        try { netCallback?.let { cm.unregisterNetworkCallback(it) } } catch (e: Exception) {}
        netCallback = null
        try { cm.bindProcessToNetwork(null) } catch (e: Exception) {}
        if (host.isEmpty() || isLanHost(host)) bindToWifi()
    }

    /** A Wi-Fi without internet makes Android send app traffic over mobile data; keep it on the Wi-Fi so the computer is reachable. */
    private fun bindToWifi() {
        try {
            val cm = getSystemService(CONNECTIVITY_SERVICE) as ConnectivityManager
            val req = NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).build()
            val cb = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) { cm.bindProcessToNetwork(network) }
                override fun onLost(network: Network) { cm.bindProcessToNetwork(null) }
            }
            netCallback = cb
            cm.requestNetwork(req, cb)
        } catch (e: Exception) {
        }
    }

    override fun onDestroy() {
        try {
            netCallback?.let { (getSystemService(CONNECTIVITY_SERVICE) as ConnectivityManager).unregisterNetworkCallback(it) }
        } catch (e: Exception) {
        }
        super.onDestroy()
    }

    // ---- update check & settings --------------------------------------------

    private class UpdateInfo(val versionCode: Int, val versionName: String, val url: String, val notes: String)

    private fun myVersionCode(): Int = try {
        val pi = packageManager.getPackageInfo(packageName, 0)
        if (Build.VERSION.SDK_INT >= 28) pi.longVersionCode.toInt() else @Suppress("DEPRECATION") pi.versionCode
    } catch (e: Exception) {
        Int.MAX_VALUE // if we somehow can't read our own version, never claim an update is available
    }

    private fun currentVersionName(): String =
        try { packageManager.getPackageInfo(packageName, 0).versionName ?: "" } catch (e: Exception) { "" }

    private fun fetchUpdateInfo(): UpdateInfo? {
        if (UPDATE_INFO_URL.contains("OWNER/REPO")) return null // not set up yet; see DISTRIBUTION-AND-UPDATES.md
        return try {
            val c = URL(UPDATE_INFO_URL).openConnection() as HttpURLConnection
            c.connectTimeout = 4000
            c.readTimeout = 4000
            c.instanceFollowRedirects = true
            val body = c.inputStream.bufferedReader().use { it.readText() }
            c.disconnect()
            val j = JSONObject(body)
            UpdateInfo(j.optInt("versionCode", -1), j.optString("versionName", ""), j.optString("url", ""), j.optString("notes", ""))
        } catch (e: Exception) {
            null
        }
    }

    /** announceIfCurrent: true for the manual "Check for updates" tap, which always says something back. */
    private fun checkForUpdate(announceIfCurrent: Boolean) {
        thread {
            val info = fetchUpdateInfo()
            runOnUiThread {
                if (isFinishing) return@runOnUiThread
                val dismissed = prefs.getInt("updateDismissed", 0)
                when {
                    info == null || info.versionCode <= 0 -> if (announceIfCurrent)
                        android.widget.Toast.makeText(this, "Couldn't check for updates.", android.widget.Toast.LENGTH_SHORT).show()
                    info.versionCode <= myVersionCode() -> if (announceIfCurrent)
                        android.widget.Toast.makeText(this, "You're up to date (v${currentVersionName()}).", android.widget.Toast.LENGTH_SHORT).show()
                    !announceIfCurrent && info.versionCode <= dismissed -> { /* dismissed already; stay quiet until next launch or a manual check */ }
                    else -> showUpdateDialog(info)
                }
            }
        }
    }

    private fun showUpdateDialog(info: UpdateInfo) {
        if (isFinishing) return
        android.app.AlertDialog.Builder(this)
            .setTitle(if (info.versionName.isNotEmpty()) "Update available — v${info.versionName}" else "Update available")
            .setMessage(if (info.notes.isNotEmpty()) info.notes else "A newer version of Presenter Remote is ready to install.")
            .setPositiveButton("Update") { d, _ ->
                d.dismiss()
                if (info.url.isNotEmpty()) {
                    try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(info.url))) } catch (e: Exception) {}
                }
            }
            .setNegativeButton("✕ Later") { d, _ ->
                prefs.edit().putInt("updateDismissed", info.versionCode).apply()
                d.dismiss()
            }
            .setCancelable(true)
            .show()
    }

    private fun showSettings() {
        if (isFinishing) return
        val addr = prefs.getString("addr", "") ?: ""
        android.app.AlertDialog.Builder(this)
            .setTitle("Settings")
            .setMessage("Presenter Remote v${currentVersionName()}" + if (addr.isNotEmpty()) "\nConnected to $addr" else "")
            .setPositiveButton("Check for updates") { d, _ -> d.dismiss(); checkForUpdate(announceIfCurrent = true) }
            .setNeutralButton("Change computer") { d, _ -> d.dismiss(); showConnect(null, false) }
            .setNegativeButton("Forget PIN") { d, _ -> d.dismiss(); prefs.edit().remove("pin").apply(); showConnect("Saved PIN removed. Enter the PIN to connect again.", false) }
            .show()
    }

    private fun press(id: String) {
        // Only act when the remote screen is showing (not the PIN screen).
        web.evaluateJavascript(
            "(function(){var s=document.getElementById('remoteScreen');var b=document.getElementById('$id');" +
                "if(s&&!s.classList.contains('hidden')&&b)b.click();})()", null
        )
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        val id = when (keyCode) {
            KeyEvent.KEYCODE_VOLUME_DOWN -> "nextBtn"
            KeyEvent.KEYCODE_VOLUME_UP -> "prevBtn"
            else -> null
        }
        if (onRemote && id != null) {
            if (event.repeatCount == 0) press(id)
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (onRemote) showConnect(null, false) else super.onBackPressed()
    }
}
