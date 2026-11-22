package com.talos.runner

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.util.UUID

@InvokeArg
class RunAndroidCodeArgs {
    lateinit var language: String
    lateinit var source: String
}

@TauriPlugin
class RunnerPlugin(private val activity: Activity) : Plugin(activity) {
    @Command
    fun runAndroidCode(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(RunAndroidCodeArgs::class.java)
            if (args.language !in setOf("python", "javascript", "c", "cpp", "java")) {
                invoke.reject("Unsupported Android run language: ${args.language}")
                return
            }
            if (args.source.toByteArray(Charsets.UTF_8).size > MAX_SOURCE_BYTES) {
                invoke.reject("Source exceeds the 96 KB Android run limit.")
                return
            }
            if (!isTermuxInstalled()) {
                invoke.reject("Install Termux from F-Droid, open it once, and install the selected language runtime.")
                return
            }
            if (activity.checkSelfPermission(RUN_COMMAND_PERMISSION) != PackageManager.PERMISSION_GRANTED) {
                invoke.reject("Allow Talos Pocket to run commands in the Termux environment in Android Settings > Apps > Talos Pocket > Permissions > Additional permissions.")
                return
            }

            startRun(invoke, args)
        } catch (error: Exception) {
            invoke.reject(error.message ?: "Could not start the Termux runner.")
        }
    }

    private fun isTermuxInstalled(): Boolean =
        try {
            activity.packageManager.getPackageInfo("com.termux", 0)
            true
        } catch (_: PackageManager.NameNotFoundException) {
            false
        }

    private fun startRun(invoke: Invoke, args: RunAndroidCodeArgs) {
        val runId = UUID.randomUUID().toString().replace("-", "")
        val action = "${activity.packageName}.RUNNER_RESULT.$runId"
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                try {
                    val result = intent.getBundleExtra(RESULT_BUNDLE)
                    if (result == null) {
                        invoke.reject("Termux returned no run result. Confirm allow-external-apps is enabled in Termux.")
                        return
                    }
                    val errorCode = result.getInt(RESULT_ERROR_CODE, Activity.RESULT_OK)
                    if (errorCode != Activity.RESULT_OK) {
                        val detail = result.getString(RESULT_ERROR_MESSAGE)
                        invoke.reject(
                            detail ?: "Termux rejected the command. Enable allow-external-apps and grant Talos the Run commands in Termux permission."
                        )
                        return
                    }
                    invoke.resolve(
                        JSObject()
                            .put("stdout", result.getString(RESULT_STDOUT).orEmpty())
                            .put("stderr", result.getString(RESULT_STDERR).orEmpty())
                            .put("code", result.getInt(RESULT_EXIT_CODE, -1))
                            .put("language", args.language)
                    )
                } finally {
                    try {
                        activity.unregisterReceiver(this)
                    } catch (_: IllegalArgumentException) {
                    }
                }
            }
        }

        val filter = IntentFilter(action)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            activity.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            activity.registerReceiver(receiver, filter)
        }

        val callbackIntent = Intent(action).setPackage(activity.packageName)
        val callback = PendingIntent.getBroadcast(
            activity,
            runId.hashCode(),
            callbackIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
        )
        val mainClass = JAVA_MAIN_CLASS.find(args.source)?.groupValues?.get(1) ?: "Main"
        val command = Intent(ACTION_RUN_COMMAND)
            .setClassName(TERMUX_PACKAGE, TERMUX_SERVICE)
            .putExtra(COMMAND_PATH, "$PREFIX/bin/timeout")
            .putExtra(
                COMMAND_ARGUMENTS,
                arrayOf("30", "$PREFIX/bin/bash", "-c", RUN_SCRIPT, "talos-runner", args.language, runId, mainClass)
            )
            .putExtra(COMMAND_STDIN, args.source)
            .putExtra(COMMAND_WORKDIR, "~/")
            .putExtra(COMMAND_BACKGROUND, true)
            .putExtra(COMMAND_PENDING_INTENT, callback)

        try {
            activity.startService(command)
        } catch (error: Exception) {
            activity.unregisterReceiver(receiver)
            throw IllegalStateException(
                "Termux refused the run request. In Termux, set allow-external-apps = true in ~/.termux/termux.properties, restart Termux, and grant Talos the Run commands permission.",
                error
            )
        }
    }

    companion object {
        private const val MAX_SOURCE_BYTES = 96 * 1024
        private const val TERMUX_PACKAGE = "com.termux"
        private const val TERMUX_SERVICE = "com.termux.app.RunCommandService"
        private const val RUN_COMMAND_PERMISSION = "com.termux.permission.RUN_COMMAND"
        private const val ACTION_RUN_COMMAND = "com.termux.RUN_COMMAND"
        private const val COMMAND_PATH = "com.termux.RUN_COMMAND_PATH"
        private const val COMMAND_ARGUMENTS = "com.termux.RUN_COMMAND_ARGUMENTS"
        private const val COMMAND_STDIN = "com.termux.RUN_COMMAND_STDIN"
        private const val COMMAND_WORKDIR = "com.termux.RUN_COMMAND_WORKDIR"
        private const val COMMAND_BACKGROUND = "com.termux.RUN_COMMAND_BACKGROUND"
        private const val COMMAND_PENDING_INTENT = "com.termux.RUN_COMMAND_PENDING_INTENT"
        private const val RESULT_BUNDLE = "com.termux.service.EXTRA_PLUGIN_RESULT_BUNDLE"
        private const val RESULT_STDOUT = "com.termux.service.EXTRA_PLUGIN_RESULT_BUNDLE_STDOUT"
        private const val RESULT_STDERR = "com.termux.service.EXTRA_PLUGIN_RESULT_BUNDLE_STDERR"
        private const val RESULT_EXIT_CODE = "com.termux.service.EXTRA_PLUGIN_RESULT_BUNDLE_EXIT_CODE"
        private const val RESULT_ERROR_CODE = "com.termux.service.EXTRA_PLUGIN_RESULT_BUNDLE_ERR"
        private const val RESULT_ERROR_MESSAGE = "com.termux.service.EXTRA_PLUGIN_RESULT_BUNDLE_ERRMSG"
        private const val PREFIX = "$" + "PREFIX"

        private val JAVA_MAIN_CLASS =
            Regex("""(?:public\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)""")

        private val RUN_SCRIPT = """
            set -eu
            language="${'$'}1"
            run_id="${'$'}2"
            main_class="${'$'}3"
            work="${'$'}HOME/.talos-runner-${'$'}run_id"
            mkdir -p "${'$'}work/classes"
            trap 'rm -rf "${'$'}work"' EXIT
            case "${'$'}language" in
              javascript)
                cat > "${'$'}work/main.js"
                node "${'$'}work/main.js"
                ;;
              python)
                cat > "${'$'}work/main.py"
                python "${'$'}work/main.py"
                ;;
              c)
                cat > "${'$'}work/main.c"
                clang "${'$'}work/main.c" -o "${'$'}work/program"
                "${'$'}work/program"
                ;;
              cpp)
                cat > "${'$'}work/main.cpp"
                clang++ "${'$'}work/main.cpp" -o "${'$'}work/program"
                "${'$'}work/program"
                ;;
              java)
                cat > "${'$'}work/${'$'}main_class.java"
                javac -d "${'$'}work/classes" "${'$'}work/${'$'}main_class.java"
                java -cp "${'$'}work/classes" "${'$'}main_class"
                ;;
              *)
                echo "Unsupported language: ${'$'}language" >&2
                exit 2
                ;;
            esac
        """.trimIndent()
    }
}
