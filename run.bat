@echo off
cd /d "%~dp0"

echo ========================================
echo  مسح الكاش القديم...
echo ========================================

REM حذف كاش Electron
if exist ".electron-runtime\Cache" rd /s /q ".electron-runtime\Cache"
if exist ".electron-runtime\Code Cache" rd /s /q ".electron-runtime\Code Cache"
if exist ".electron-runtime\GPUCache" rd /s /q ".electron-runtime\GPUCache"
if exist ".electron-runtime\DawnGraphiteCache" rd /s /q ".electron-runtime\DawnGraphiteCache"
if exist ".electron-runtime\DawnWebGPUCache" rd /s /q ".electron-runtime\DawnWebGPUCache"
if exist ".electron-runtime\ShaderCache" rd /s /q ".electron-runtime\ShaderCache"

echo ✅ تم مسح الكاش بنجاح
echo ========================================
echo  تشغيل التطبيق...
echo ========================================

npm run dev
