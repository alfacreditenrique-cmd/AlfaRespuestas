using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

namespace AlfaRespuestas
{
    public class InstallerForm : Form
    {
        private Label lblTitle;
        private Label lblSubtitle;
        private Label lblPath;
        private TextBox txtPath;
        private Button btnBrowse;
        private CheckBox chkDesktopShortcut;
        private CheckBox chkStartNow;
        private Button btnInstall;
        private ProgressBar progressBar;
        private Label lblStatus;
        private Panel topPanel;

        [STAThread]
        public static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new InstallerForm());
        }

        public InstallerForm()
        {
            this.Text = "Instalador AlfaRespuestas - AlfaCredit S.A.";
            this.Size = new Size(580, 420);
            this.StartPosition = FormStartPosition.CenterScreen;
            this.FormBorderStyle = FormBorderStyle.FixedDialog;
            this.MaximizeBox = false;
            this.BackColor = Color.FromArgb(248, 250, 252);
            this.Font = new Font("Segoe UI", 9F, FontStyle.Regular, GraphicsUnit.Point);

            // Panel Superior Azul Corporativo
            topPanel = new Panel();
            topPanel.Dock = DockStyle.Top;
            topPanel.Height = 85;
            topPanel.BackColor = Color.FromArgb(30, 58, 138);

            lblTitle = new Label();
            lblTitle.Text = "AlfaCredit S.A. - AlfaRespuestas";
            lblTitle.Font = new Font("Segoe UI", 14F, FontStyle.Bold);
            lblTitle.ForeColor = Color.White;
            lblTitle.Location = new Point(20, 16);
            lblTitle.AutoSize = true;

            lblSubtitle = new Label();
            lblSubtitle.Text = "Instalación del sistema de gestión de entrevistas y WhatsApp Bot";
            lblSubtitle.Font = new Font("Segoe UI", 9F, FontStyle.Regular);
            lblSubtitle.ForeColor = Color.FromArgb(219, 234, 254);
            lblSubtitle.Location = new Point(22, 48);
            lblSubtitle.AutoSize = true;

            topPanel.Controls.Add(lblTitle);
            topPanel.Controls.Add(lblSubtitle);
            this.Controls.Add(topPanel);

            // Directorio de Instalación
            lblPath = new Label();
            lblPath.Text = "Carpeta de destino para la instalación:";
            lblPath.Location = new Point(25, 105);
            lblPath.AutoSize = true;
            lblPath.Font = new Font("Segoe UI", 9F, FontStyle.Bold);
            lblPath.ForeColor = Color.FromArgb(30, 41, 59);
            this.Controls.Add(lblPath);

            txtPath = new TextBox();
            txtPath.Location = new Point(25, 130);
            txtPath.Size = new Size(410, 26);
            txtPath.Text = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AlfaRespuestas");
            this.Controls.Add(txtPath);

            btnBrowse = new Button();
            btnBrowse.Text = "Examinar...";
            btnBrowse.Location = new Point(445, 128);
            btnBrowse.Size = new Size(95, 29);
            btnBrowse.Click += OnBrowse;
            this.Controls.Add(btnBrowse);

            // Opciones de Acceso Directo y Ejecución
            chkDesktopShortcut = new CheckBox();
            chkDesktopShortcut.Text = "Crear acceso directo en el Escritorio de Windows";
            chkDesktopShortcut.Location = new Point(25, 175);
            chkDesktopShortcut.AutoSize = true;
            chkDesktopShortcut.Checked = true;
            this.Controls.Add(chkDesktopShortcut);

            chkStartNow = new CheckBox();
            chkStartNow.Text = "Iniciar AlfaRespuestas automáticamente al completar";
            chkStartNow.Location = new Point(25, 205);
            chkStartNow.AutoSize = true;
            chkStartNow.Checked = true;
            this.Controls.Add(chkStartNow);

            // Barra de Progreso y Estado
            progressBar = new ProgressBar();
            progressBar.Location = new Point(25, 245);
            progressBar.Size = new Size(515, 22);
            progressBar.Style = ProgressBarStyle.Continuous;
            this.Controls.Add(progressBar);

            lblStatus = new Label();
            lblStatus.Text = "Listo para iniciar la instalación.";
            lblStatus.Location = new Point(25, 275);
            lblStatus.Size = new Size(515, 20);
            lblStatus.ForeColor = Color.FromArgb(71, 85, 105);
            this.Controls.Add(lblStatus);

            // Botón Instalar
            btnInstall = new Button();
            btnInstall.Text = "Instalar Ahora";
            btnInstall.Location = new Point(395, 320);
            btnInstall.Size = new Size(145, 36);
            btnInstall.BackColor = Color.FromArgb(37, 99, 235);
            btnInstall.ForeColor = Color.White;
            btnInstall.Font = new Font("Segoe UI", 10F, FontStyle.Bold);
            btnInstall.FlatStyle = FlatStyle.Flat;
            btnInstall.FlatAppearance.BorderSize = 0;
            btnInstall.Click += OnInstall;
            this.Controls.Add(btnInstall);
        }

        private void OnBrowse(object sender, EventArgs e)
        {
            using (FolderBrowserDialog fbd = new FolderBrowserDialog())
            {
                fbd.Description = "Selecciona la carpeta donde deseas instalar AlfaRespuestas:";
                if (fbd.ShowDialog() == DialogResult.OK)
                {
                    txtPath.Text = Path.Combine(fbd.SelectedPath, "AlfaRespuestas");
                }
            }
        }

        private void OnInstall(object sender, EventArgs e)
        {
            btnInstall.Enabled = false;
            btnBrowse.Enabled = false;
            txtPath.Enabled = false;
            chkDesktopShortcut.Enabled = false;
            chkStartNow.Enabled = false;

            string targetDir = txtPath.Text.Trim();
            bool createShortcut = chkDesktopShortcut.Checked;
            bool launch = chkStartNow.Checked;

            Thread worker = new Thread(() =>
            {
                try
                {
                    UpdateStatus("Preparando directorio de destino...", 10);
                    if (!Directory.Exists(targetDir))
                    {
                        Directory.CreateDirectory(targetDir);
                    }

                    UpdateStatus("Extrayendo archivos y runtime de Node.js empaquetado...", 25);
                    
                    // Extraer recurso embebido 'payload'
                    Assembly asm = Assembly.GetExecutingAssembly();
                    string tempZip = Path.Combine(Path.GetTempPath(), "alfa_payload_" + Guid.NewGuid().ToString("N") + ".zip");

                    using (Stream resStream = asm.GetManifestResourceStream("payload"))
                    {
                        if (resStream == null)
                        {
                            throw new Exception("No se encontró el paquete de instalación embebido.");
                        }

                        using (FileStream fs = new FileStream(tempZip, FileMode.Create, FileAccess.Write))
                        {
                            resStream.CopyTo(fs);
                        }
                    }

                    UpdateStatus("Descomprimiendo sistema AlfaRespuestas...", 50);
                    using (ZipArchive archive = ZipFile.OpenRead(tempZip))
                    {
                        int total = archive.Entries.Count;
                        int count = 0;
                        foreach (ZipArchiveEntry entry in archive.Entries)
                        {
                            string rel = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
                            if (rel.StartsWith("." + Path.DirectorySeparatorChar))
                            {
                                rel = rel.Substring(2);
                            }
                            if (string.IsNullOrEmpty(rel) || rel == "." || rel == ".\\") continue;

                            string destPath = Path.Combine(targetDir, rel);
                            string destDir = Path.GetDirectoryName(destPath);
                            if (!string.IsNullOrEmpty(destDir) && !Directory.Exists(destDir))
                            {
                                Directory.CreateDirectory(destDir);
                            }

                            if (!string.IsNullOrEmpty(entry.Name))
                            {
                                entry.ExtractToFile(destPath, true);
                            }

                            count++;
                            if (count % 20 == 0)
                            {
                                int pct = 50 + (int)((float)count / total * 35);
                                UpdateStatus("Extrayendo: " + entry.Name, pct);
                            }
                        }
                    }

                    try { File.Delete(tempZip); } catch { }

                    UpdateStatus("Configurando accesos directos...", 90);
                    string exePath = Path.Combine(targetDir, "AlfaRespuestas.exe");

                    if (createShortcut && File.Exists(exePath))
                    {
                        CreateDesktopShortcut(exePath, targetDir);
                    }

                    UpdateStatus("¡Instalación completada con éxito!", 100);

                    this.Invoke((MethodInvoker)delegate
                    {
                        MessageBox.Show(
                            "AlfaRespuestas se ha instalado correctamente en:\n" + targetDir + "\n\n" +
                            "El sistema está listo para ser utilizado en esta máquina.",
                            "Instalación Exitosa",
                            MessageBoxButtons.OK,
                            MessageBoxIcon.Information
                        );

                        if (launch && File.Exists(exePath))
                        {
                            Process.Start(new ProcessStartInfo
                            {
                                FileName = exePath,
                                WorkingDirectory = targetDir
                            });
                        }

                        Application.Exit();
                    });
                }
                catch (Exception ex)
                {
                    this.Invoke((MethodInvoker)delegate
                    {
                        MessageBox.Show(
                            "Ocurrió un error durante la instalación:\n" + ex.Message,
                            "Error de Instalación",
                            MessageBoxButtons.OK,
                            MessageBoxIcon.Error
                        );
                        btnInstall.Enabled = true;
                        btnBrowse.Enabled = true;
                        txtPath.Enabled = true;
                        chkDesktopShortcut.Enabled = true;
                        chkStartNow.Enabled = true;
                    });
                }
            });

            worker.IsBackground = true;
            worker.Start();
        }

        private void UpdateStatus(string text, int progress)
        {
            if (this.InvokeRequired)
            {
                this.Invoke((MethodInvoker)delegate { UpdateStatus(text, progress); });
                return;
            }

            lblStatus.Text = text;
            progressBar.Value = Math.Min(100, Math.Max(0, progress));
        }

        private void CreateDesktopShortcut(string targetExe, string workingDir)
        {
            try
            {
                string desktopPath = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                string shortcutPath = Path.Combine(desktopPath, "AlfaRespuestas.lnk");

                // Generar acceso directo mediante WScript.Shell (nativo en Windows)
                Type shellType = Type.GetTypeFromProgID("WScript.Shell");
                if (shellType != null)
                {
                    dynamic shell = Activator.CreateInstance(shellType);
                    dynamic shortcut = shell.CreateShortcut(shortcutPath);
                    shortcut.TargetPath = targetExe;
                    shortcut.WorkingDirectory = workingDir;
                    shortcut.Description = "Sistema de Gestión de Entrevistas - AlfaCredit S.A.";
                    shortcut.IconLocation = targetExe + ",0";
                    shortcut.Save();
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine("No se pudo crear acceso directo en el escritorio: " + ex.Message);
            }
        }
    }
}
