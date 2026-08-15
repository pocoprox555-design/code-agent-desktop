import { useState, useCallback } from 'react'

interface Card {
  id: number
  title: string
  body: string
  icon: string
}

const initialCards: Card[] = [
  { id: 1, title: 'تصميم عصري', body: 'واجهة نظيفة ومتجاوبة مع جميع أحجام الشاشات. مبنية بـ React 19 و TypeScript.', icon: '🎨' },
  { id: 2, title: 'جاهز للنشر', body: 'ابنِ وشارك رابطًا عامًا بنقرة زر واحدة عبر GitHub Pages.', icon: '🚀' },
  { id: 3, title: 'كود نظيف', body: 'TypeScript صارم + Vite فائق السرعة + هيكل ملفات احترافي.', icon: '✨' },
  { id: 4, title: 'مجاني بالكامل', body: 'لا حاجة لبطاقة ائتمان أو اشتراك. ابنِ وشارك بلا حدود.', icon: '💎' },
  { id: 5, title: 'قابل للتخصيص', body: 'عدّل الألوان والمكونات والمحتوى بسهولة — كل شيء مكوّن منفصل.', icon: '🎯' },
  { id: 6, title: 'أداء فائق', body: 'Vite + React 19 = تحميل فوري وتجربة مستخدم سلسة.', icon: '⚡' },
]

export default function App() {
  const [cards, setCards] = useState<Card[]>([])
  const [built, setBuilt] = useState(false)

  const handleBuild = useCallback(() => {
    setCards(initialCards)
    setBuilt(true)
  }, [])

  return (
    <div className="app">
      <header className="hero">
        <h1>
          مرحبًا بك في <span>{{projectName}}</span>
        </h1>
        <p className="subtitle">{{description}}</p>
        <button
          className={`btn-primary ${built ? 'built' : ''}`}
          onClick={handleBuild}
        >
          {built ? '✓ تم البناء!' : 'اضغط للبدء'}
        </button>
      </header>

      <main className="container">
        {cards.length > 0 && (
          <section className="card-grid">
            {cards.map((card) => (
              <article key={card.id} className="card">
                <span className="card-icon">{card.icon}</span>
                <h3>{card.title}</h3>
                <p>{card.body}</p>
              </article>
            ))}
          </section>
        )}
      </main>

      <footer>
        <p>
          بُني بواسطة <strong>Code Agent</strong> — انشر وشارك بنقرة واحدة
        </p>
      </footer>
    </div>
  )
}
