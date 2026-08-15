import type { Attachment } from '../../shared/types'

const MAX_IMAGE_EDGE = 1600
const JPEG_QUALITY = 0.8

export async function compressImageAttachment(file: File, fallbackName = 'pasted-image.jpg'): Promise<Attachment> {
  if (!file.type.startsWith('image/')) throw new Error('الملف ليس صورة')
  const bitmap = await createImageBitmap(file)
  try {
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new Error('تعذر تجهيز الصورة')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, width, height)
    context.drawImage(bitmap, 0, 0, width, height)
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('تعذر ضغط الصورة')), 'image/jpeg', JPEG_QUALITY))
    const data = await blob.arrayBuffer()
    const originalName = file.name || fallbackName
    const name = /\.[a-z0-9]+$/i.test(originalName) ? originalName.replace(/\.[a-z0-9]+$/i, '.jpg') : `${originalName}.jpg`
    return { name, mimeType: 'image/jpeg', data: arrayBufferToBase64(data), size: blob.size }
  } finally {
    bitmap.close()
  }
}

function arrayBufferToBase64(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data)
  let binary = ''
  const chunkSize = 32_768
  for (let offset = 0; offset < bytes.length; offset += chunkSize) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  return btoa(binary)
}
