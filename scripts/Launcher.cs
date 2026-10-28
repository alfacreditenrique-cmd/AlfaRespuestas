using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Windows.Forms;

namespace AlfaRespuestas
{
    public class Launcher : Form
    {
        private NotifyIcon trayIcon;
        private ContextMenu trayMenu;
        private Process nodeProcess;
        private string appDir;
        private string nodePath;
        private string scriptPath;

        [STAThread]
        public static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new Launcher());
        }

        public Launcher()
        {
            this.WindowState = FormWindowState.Minimized;
            this.ShowInTaskbar = false;
            this.Visible = false;

            appDir = AppDomain.CurrentDomain.BaseDirectory;
            nodePath = Path.Combine(appDir, "node.exe");
            scriptPath = Path.Combine(appDir, "src", "server.js");

            // Si node.exe no está en la raíz, buscar en PATH
            if (!File.Exists(nodePath))
            {
                nodePath = "node.exe";
            }

            trayMenu = new ContextMenu();
            trayMenu.MenuItems.Add("Abrir Panel AlfaRespuestas", OnOpenBrowser);
            trayMenu.MenuItems.Add("-");
            trayMenu.MenuItems.Add("Reiniciar Servidor", OnRestartServer);
            trayMenu.MenuItems.Add("Detener y Salir", OnExit);

            trayIcon = new NotifyIcon();
            trayIcon.Text = "AlfaRespuestas - AlfaCredit S.A.";
            trayIcon.Icon = SystemIcons.Application;
            trayIcon.ContextMenu = trayMenu;
            trayIcon.Visible = true;
            trayIcon.DoubleClick += OnOpenBrowser;

            StartServer();

            // Abrir navegador tras 1.5 segundos
            Thread t = new Thread(() =>
            {
                Thread.Sleep(1500);
                OpenBrowser();
            });
            t.IsBackground = true;
            t.Start();
        }

        private void StartServer()
        {
            try
            {
                if (nodeProcess != null && !nodeProcess.HasExited)
                {
                    try { nodeProcess.Kill(); } catch { }
                }

                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = nodePath;
                psi.Arguments = "\"" + scriptPath + "\"";
                psi.WorkingDirectory = appDir;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                psi.RedirectStandardError = true;

                nodeProcess = Process.Start(psi);
                if (nodeProcess.WaitForExit(1200))
                {
                    string err = nodeProcess.StandardError.ReadToEnd();
                    MessageBox.Show("El servidor no pudo iniciar correctamente:\n" + err, "Error AlfaRespuestas", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return;
                }

                trayIcon.ShowBalloonTip(3000, "AlfaRespuestas Iniciado", "El servidor de AlfaCredit S.A. está corriendo en http://localhost:3000", ToolTipIcon.Info);
            }
            catch (Exception ex)
            {
                MessageBox.Show("Error iniciando el servidor AlfaRespuestas: " + ex.Message, "Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void OpenBrowser()
        {
            try
            {
                Process.Start("http://localhost:3000");
            }
            catch (Exception ex)
            {
                MessageBox.Show("No se pudo abrir el navegador automáticamente: " + ex.Message);
            }
        }

        private void OnOpenBrowser(object sender, EventArgs e)
        {
            OpenBrowser();
        }

        private void OnRestartServer(object sender, EventArgs e)
        {
            StartServer();
        }

        private void OnExit(object sender, EventArgs e)
        {
            if (nodeProcess != null && !nodeProcess.HasExited)
            {
                try { nodeProcess.Kill(); } catch { }
            }
            trayIcon.Visible = false;
            Application.Exit();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (nodeProcess != null && !nodeProcess.HasExited)
            {
                try { nodeProcess.Kill(); } catch { }
            }
            if (trayIcon != null)
            {
                trayIcon.Visible = false;
            }
            base.OnFormClosing(e);
        }
    }
}
