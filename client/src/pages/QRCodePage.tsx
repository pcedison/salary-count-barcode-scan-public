import { useState, useEffect, useRef } from 'react';
import QRCodeLib from 'qrcode';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Download, Printer, QrCode } from 'lucide-react';
import { useAdmin } from '@/hooks/useAdmin';

const LIFF_ID = import.meta.env.VITE_LIFF_ID;

export default function QRCodePage() {
  const { isAdmin } = useAdmin();
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [clockInUrl, setClockInUrl] = useState('');
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const url = LIFF_ID
      ? `https://liff.line.me/${LIFF_ID}`
      : `${window.location.origin}/clock-in`;
    setClockInUrl(url);

    QRCodeLib.toDataURL(url, {
      width: 600,
      margin: 2,
      errorCorrectionLevel: 'H',
      color: { dark: '#000000', light: '#ffffff' }
    })
      .then(setQrDataUrl)
      .catch(console.error);
  }, []);

  const handleDownload = () => {
    if (!qrDataUrl) return;
    const link = document.createElement('a');
    link.download = 'line-clock-in-qrcode.png';
    link.href = qrDataUrl;
    link.click();
  };

  const handlePrint = () => {
    if (!qrDataUrl) return;
    const win = window.open('', '_blank');
    if (!win) return;
    win.document.write(`
      <html>
        <head>
          <title>LINE 打卡 QR Code</title>
          <style>
            body { display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:100vh; margin:0; font-family:sans-serif; }
            h1 { font-size:28px; margin-bottom:8px; }
            p { color:#555; margin-bottom:24px; font-size:16px; }
            img { width:400px; height:400px; }
            small { margin-top:16px; color:#888; font-size:12px; }
          </style>
        </head>
        <body>
          <h1>員工打卡</h1>
          <p>掃描 QR Code，使用 LINE 帳號打卡</p>
          <img src="${qrDataUrl}" alt="QR Code" />
          <small>${clockInUrl}</small>
          <script>window.onload = () => { window.print(); window.close(); }</script>
        </body>
      </html>
    `);
    win.document.close();
  };

  if (!isAdmin) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4 sm:p-6">
        <Card className="w-full max-w-sm rounded-2xl shadow-sm">
          <CardContent className="pt-6 text-center text-gray-500">
            需要管理員權限才能查看此頁面
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4 sm:p-6">
      <Card className="w-full max-w-lg rounded-2xl shadow-lg">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-2">
            <QrCode className="h-8 w-8 text-green-600" />
          </div>
          <CardTitle className="text-xl">LINE 打卡 QR Code</CardTitle>
          <CardDescription>
            將此 QR Code 張貼於打卡處，員工掃描後可用 LINE 帳號打卡
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {qrDataUrl ? (
            <div className="flex justify-center">
              <img
                src={qrDataUrl}
                alt="LINE 打卡 QR Code"
                className="h-auto w-full max-w-[16rem] rounded-lg border-4 border-green-200 sm:max-w-[18rem]"
              />
            </div>
          ) : (
            <div className="flex justify-center py-16 text-gray-400">產生中...</div>
          )}

          <p className="text-xs text-center text-gray-400 font-mono break-all">{clockInUrl}</p>

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              variant="outline"
              className="flex-1 gap-2"
              onClick={handleDownload}
              disabled={!qrDataUrl}
            >
              <Download className="h-4 w-4" />
              下載 PNG
            </Button>
            <Button
              className="flex-1 gap-2 bg-green-600 hover:bg-green-700"
              onClick={handlePrint}
              disabled={!qrDataUrl}
            >
              <Printer className="h-4 w-4" />
              列印
            </Button>
          </div>

          <canvas ref={canvasRef} className="hidden" />
        </CardContent>
      </Card>
    </div>
  );
}
