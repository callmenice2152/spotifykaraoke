using System;
using System.Globalization;
using System.Runtime.InteropServices;

namespace SpotifyAuto {
    class ScreenSampler {
        [DllImport("user32.dll")]
        static extern IntPtr GetDC(IntPtr hwnd);

        [DllImport("user32.dll")]
        static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);

        [DllImport("gdi32.dll")]
        static extern uint GetPixel(IntPtr hdc, int nXPos, int nYPos);

        const uint CLR_INVALID = 0xFFFFFFFF;

        static void Main(string[] args) {
            string line;
            while ((line = Console.ReadLine()) != null) {
                line = line.Trim();
                if (string.IsNullOrEmpty(line)) continue;
                if (line.Equals("exit", StringComparison.OrdinalIgnoreCase)) break;

                string[] parts = line.Split(new char[] { ' ', '\t', ',' }, StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length < 4) {
                    Console.WriteLine("dark");
                    continue;
                }

                int x, y, w, h;
                if (!int.TryParse(parts[0], out x) ||
                    !int.TryParse(parts[1], out y) ||
                    !int.TryParse(parts[2], out w) ||
                    !int.TryParse(parts[3], out h)) {
                    Console.WriteLine("dark");
                    continue;
                }

                if (w <= 0) w = 240;
                if (h <= 0) h = 32;

                IntPtr hdc = GetDC(IntPtr.Zero);
                if (hdc == IntPtr.Zero) {
                    Console.WriteLine("dark");
                    continue;
                }

                double totalLum = 0;
                int validSamples = 0;

                // Sample 5 columns x 3 rows = 15 sample points across the bounding box
                int cols = 5;
                int rows = 3;

                for (int r = 0; r < rows; r++) {
                    int sampleY = y + (int)((r + 0.5) * h / rows);
                    for (int c = 0; c < cols; c++) {
                        int sampleX = x + (int)((c + 0.5) * w / cols);

                        uint color = GetPixel(hdc, sampleX, sampleY);
                        if (color != CLR_INVALID) {
                            uint red = color & 0x000000FF;
                            uint green = (color & 0x0000FF00) >> 8;
                            uint blue = (color & 0x00FF0000) >> 16;
                            double lum = 0.299 * red + 0.587 * green + 0.114 * blue;
                            totalLum += lum;
                            validSamples++;
                        }
                    }
                }

                ReleaseDC(IntPtr.Zero, hdc);

                if (validSamples > 0) {
                    double avgLum = totalLum / validSamples;
                    // Threshold: > 140 is considered light/white background
                    if (avgLum > 140) {
                        Console.WriteLine("light");
                    } else {
                        Console.WriteLine("dark");
                    }
                } else {
                    Console.WriteLine("dark");
                }
            }
        }
    }
}
