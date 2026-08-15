// ─── موقع {{projectName}} ───

const cards = [
  { title: 'تصميم عصري', body: 'واجهة نظيفة ومتجاوبة مع جميع أحجام الشاشات.' },
  { title: 'جاهز للنشر', body: 'ابنِ وشارك رابطًا عامًا بنقرة زر واحدة.' },
  { title: 'كود نظيف', body: 'HTML و CSS و JavaScript خالص بدون تعقيد.' },
  { title: 'مجاني بالكامل', body: 'لا حاجة لبطاقة ائتمان أو اشتراك.' },
  { title: 'قابل للتخصيص', body: 'عدّل الألوان والخطوط والمحتوى بسهولة.' },
  { title: 'سريع الأداء', body: 'تصميم خفيف يحمّل في أقل من ثانية.' },
]

function renderCards() {
  const grid = document.getElementById('content')
  if (!grid) return
  grid.innerHTML = cards.map(card => `
    <article class="card">
      <h3>${card.title}</h3>
      <p>${card.body}</p>
    </article>
  `).join('')
}

function setupButton() {
  const btn = document.getElementById('actionBtn')
  if (!btn) return
  btn.addEventListener('click', () => {
    renderCards()
    btn.textContent = '✓ تم البناء!'
    btn.style.background = 'var(--green)'
    setTimeout(() => {
      btn.textContent = 'اضغط للبدء'
      btn.style.background = ''
    }, 2000)
  })
}

// ─── Init ───
document.addEventListener('DOMContentLoaded', () => {
  setupButton()
})
