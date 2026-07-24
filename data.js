// Контакты магазина для кнопок-заявок (Купить / Доставка).
// wa — номер WhatsApp в межд. формате без + (напр. 996700123456). tg — username Telegram.
const STORE = { name: "МОСТОВОЙ", wa: "", tg: "mostovoyshop" };

// Каталог. ТТХ — фактические. Цены — примерные (демо), замени на свои.
// brand: Apple | Samsung · style: apple | samsung (для рендера камеры)
// tone — цвет корпуса; lenses — число камер; swatches — доступные цвета.
const PHONES = [
  // ================= APPLE =================
  {
    id: "16-pro-max", brand: "Apple", style: "apple", name: "iPhone 16 Pro Max", gen: "16", badge: "Новинка",
    price: 139990, tone: "#3a3a3c", lenses: 3,
    display: "6,9″ Super Retina XDR, ProMotion 120 Гц",
    chip: "A18 Pro", camera: "48 Мп + 48 Мп ультраширокая + 12 Мп телефото 5×",
    battery: "до 33 ч видео", material: "Титан Grade 5",
    storage: "256 ГБ / 512 ГБ / 1 ТБ", os: "iOS 18", weight: "227 г",
    connector: "USB-C (USB 3)", water: "IP68", front: "12 Мп TrueDepth",
    colors: "Титановый чёрный, белый, натуральный, пустынный",
    swatches: [["Чёрный","#3a3a3c"],["Белый","#e8e6e1"],["Натуральный","#b8a99a"],["Пустынный","#c7a97e"]],
    desc: "Самый большой и мощный iPhone. Титановый корпус, дисплей 6,9″ с ProMotion 120 Гц, чип A18 Pro и телеобъектив 5×. Кнопка Camera Control для быстрого доступа к камере."
  },
  {
    id: "16-pro", brand: "Apple", style: "apple", name: "iPhone 16 Pro", gen: "16", badge: "Новинка",
    price: 119990, tone: "#4a4a4c", lenses: 3,
    display: "6,3″ Super Retina XDR, ProMotion 120 Гц",
    chip: "A18 Pro", camera: "48 Мп + 48 Мп ультраширокая + 12 Мп телефото 5×",
    battery: "до 27 ч видео", material: "Титан Grade 5",
    storage: "128 ГБ / 256 ГБ / 512 ГБ / 1 ТБ", os: "iOS 18", weight: "199 г",
    connector: "USB-C (USB 3)", water: "IP68", front: "12 Мп TrueDepth",
    colors: "Титановый чёрный, белый, натуральный, пустынный",
    swatches: [["Чёрный","#4a4a4c"],["Белый","#e8e6e1"],["Натуральный","#b8a99a"],["Пустынный","#c7a97e"]],
    desc: "Профессиональная камера в компактном титановом корпусе 6,3″. Чип A18 Pro, ProMotion 120 Гц и телеобъектив 5×. Всё лучшее от Pro Max в удобном формате."
  },
  {
    id: "16-plus", brand: "Apple", style: "apple", name: "iPhone 16 Plus", gen: "16", badge: "",
    price: 99990, tone: "#4f9ce8", lenses: 2,
    display: "6,7″ Super Retina XDR, 60 Гц",
    chip: "A18", camera: "48 Мп основная + 12 Мп ультраширокая",
    battery: "до 33 ч видео", material: "Алюминий",
    storage: "128 ГБ / 256 ГБ / 512 ГБ", os: "iOS 18", weight: "199 г",
    connector: "USB-C", water: "IP68", front: "12 Мп TrueDepth",
    colors: "Ультрамарин, бирюзовый, розовый, белый, чёрный",
    swatches: [["Ультрамарин","#4f6ce8"],["Бирюзовый","#5ac8d8"],["Розовый","#f2b8c6"],["Белый","#e8e6e1"],["Чёрный","#2a2a2c"]],
    desc: "Большой экран 6,7″ и рекордная автономность до 33 часов видео. Чип A18, двойная камера 48 Мп и кнопка Camera Control. Пять ярких цветов."
  },
  {
    id: "16", brand: "Apple", style: "apple", name: "iPhone 16", gen: "16", badge: "",
    price: 89990, tone: "#5ac8d8", lenses: 2,
    display: "6,1″ Super Retina XDR, 60 Гц",
    chip: "A18", camera: "48 Мп основная + 12 Мп ультраширокая",
    battery: "до 22 ч видео", material: "Алюминий",
    storage: "128 ГБ / 256 ГБ / 512 ГБ", os: "iOS 18", weight: "170 г",
    connector: "USB-C", water: "IP68", front: "12 Мп TrueDepth",
    colors: "Ультрамарин, бирюзовый, розовый, белый, чёрный",
    swatches: [["Ультрамарин","#4f6ce8"],["Бирюзовый","#5ac8d8"],["Розовый","#f2b8c6"],["Белый","#e8e6e1"],["Чёрный","#2a2a2c"]],
    desc: "Новый iPhone 16 с чипом A18, двойной камерой 48 Мп и кнопкой Camera Control. Идеальный баланс размера, скорости и цены."
  },
  {
    id: "15-pro-max", brand: "Apple", style: "apple", name: "iPhone 15 Pro Max", gen: "15", badge: "",
    price: 129990, tone: "#8a8a8d", lenses: 3,
    display: "6,7″ Super Retina XDR, ProMotion 120 Гц",
    chip: "A17 Pro", camera: "48 Мп + 12 Мп ультраширокая + 12 Мп телефото 5×",
    battery: "до 29 ч видео", material: "Титан Grade 5",
    storage: "256 ГБ / 512 ГБ / 1 ТБ", os: "iOS 18", weight: "221 г",
    connector: "USB-C (USB 3)", water: "IP68", front: "12 Мп TrueDepth",
    colors: "Титановый чёрный, белый, синий, натуральный",
    swatches: [["Чёрный","#4a4a4c"],["Белый","#e8e6e1"],["Синий","#4a5a6a"],["Натуральный","#b8a99a"]],
    desc: "Титановый флагман прошлого поколения с телеобъективом 5× и чипом A17 Pro. Дисплей 6,7″ ProMotion. Отличный выбор с выгодой."
  },
  {
    id: "15-pro", brand: "Apple", style: "apple", name: "iPhone 15 Pro", gen: "15", badge: "",
    price: 99990, tone: "#7d7d80", lenses: 3,
    display: "6,1″ Super Retina XDR, ProMotion 120 Гц",
    chip: "A17 Pro", camera: "48 Мп + 12 Мп ультраширокая + 12 Мп телефото 3×",
    battery: "до 23 ч видео", material: "Титан Grade 5",
    storage: "128 ГБ / 256 ГБ / 512 ГБ / 1 ТБ", os: "iOS 18", weight: "187 г",
    connector: "USB-C (USB 3)", water: "IP68", front: "12 Мп TrueDepth",
    colors: "Титановый чёрный, белый, синий, натуральный",
    swatches: [["Чёрный","#4a4a4c"],["Белый","#e8e6e1"],["Синий","#4a5a6a"],["Натуральный","#b8a99a"]],
    desc: "Компактный Pro в титане с чипом A17 Pro и ProMotion 120 Гц. Кнопка «Действие» вместо переключателя и порт USB-C."
  },
  {
    id: "15", brand: "Apple", style: "apple", name: "iPhone 15", gen: "15", badge: "Хит",
    price: 79990, tone: "#1c1c1e", lenses: 2,
    display: "6,1″ Super Retina XDR, 60 Гц",
    chip: "A16 Bionic", camera: "48 Мп основная + 12 Мп ультраширокая",
    battery: "до 20 ч видео", material: "Алюминий",
    storage: "128 ГБ / 256 ГБ / 512 ГБ", os: "iOS 18", weight: "171 г",
    connector: "USB-C", water: "IP68", front: "12 Мп TrueDepth",
    colors: "Розовый, жёлтый, зелёный, синий, чёрный",
    swatches: [["Чёрный","#2a2a2c"],["Розовый","#f2b8c6"],["Жёлтый","#efe0a0"],["Зелёный","#b9d0bd"],["Синий","#bcd0dc"]],
    desc: "Самый популярный iPhone. Dynamic Island, камера 48 Мп и порт USB-C. Чип A16 Bionic. Лучшее сочетание цены и возможностей."
  },
  {
    id: "14", brand: "Apple", style: "apple", name: "iPhone 14", gen: "14", badge: "",
    price: 64990, tone: "#6f42c1", lenses: 2,
    display: "6,1″ Super Retina XDR, 60 Гц",
    chip: "A15 Bionic", camera: "12 Мп основная + 12 Мп ультраширокая",
    battery: "до 20 ч видео", material: "Алюминий",
    storage: "128 ГБ / 256 ГБ / 512 ГБ", os: "iOS 18", weight: "172 г",
    connector: "Lightning", water: "IP68", front: "12 Мп TrueDepth",
    colors: "Фиолетовый, синий, полуночный, красный",
    swatches: [["Фиолетовый","#a898d0"],["Синий","#a8c4d8"],["Полуночный","#2a2f38"],["Красный","#c0392b"]],
    desc: "Надёжный iPhone 14 с двойной камерой 12 Мп и чипом A15 Bionic. Экстренный вызов SOS и распознавание аварий. Порт Lightning."
  },
  {
    id: "13", brand: "Apple", style: "apple", name: "iPhone 13", gen: "13", badge: "Выгодно",
    price: 54990, tone: "#e56a7a", lenses: 2,
    display: "6,1″ Super Retina XDR, 60 Гц",
    chip: "A15 Bionic", camera: "12 Мп основная + 12 Мп ультраширокая",
    battery: "до 19 ч видео", material: "Алюминий",
    storage: "128 ГБ / 256 ГБ / 512 ГБ", os: "iOS 18", weight: "173 г",
    connector: "Lightning", water: "IP68", front: "12 Мп TrueDepth",
    colors: "Розовый, синий, полуночный, красный",
    swatches: [["Розовый","#f0d4d0"],["Синий","#4a6a8a"],["Полуночный","#2a2f38"],["Красный","#c0392b"]],
    desc: "Проверенная классика по выгодной цене. Камера 12 Мп с оптической стабилизацией, чип A15 Bionic и яркий OLED-экран."
  },
  {
    id: "se", brand: "Apple", style: "apple", name: "iPhone SE", gen: "SE", badge: "",
    price: 44990, tone: "#222225", lenses: 1,
    display: "4,7″ Retina HD, Touch ID",
    chip: "A15 Bionic", camera: "12 Мп основная",
    battery: "до 15 ч видео", material: "Алюминий",
    storage: "64 ГБ / 128 ГБ / 256 ГБ", os: "iOS 18", weight: "144 г",
    connector: "Lightning", water: "IP67", front: "7 Мп FaceTime HD",
    colors: "Полуночный, сияющая звезда, красный",
    swatches: [["Полуночный","#2a2f38"],["Звезда","#e8e6e1"],["Красный","#c0392b"]],
    desc: "Компактный iPhone с кнопкой Home и Touch ID. Чип A15 Bionic делает его быстрым, а цена — самой доступной в линейке."
  },

  // ================= SAMSUNG =================
  {
    id: "s24-ultra", brand: "Samsung", style: "samsung", name: "Galaxy S24 Ultra", gen: "S24", badge: "Новинка",
    price: 119990, tone: "#6b6b70", lenses: 4,
    display: "6,8″ Dynamic AMOLED 2X, QHD+ 120 Гц",
    chip: "Snapdragon 8 Gen 3", camera: "200 Мп + 50 Мп + 12 Мп + 10 Мп",
    battery: "5000 мА·ч", material: "Титан",
    storage: "256 ГБ / 512 ГБ / 1 ТБ", os: "Android 14 (One UI 6.1)", weight: "232 г",
    connector: "USB-C", water: "IP68", front: "12 Мп",
    colors: "Титановый чёрный, серый, фиолетовый, жёлтый",
    swatches: [["Чёрный","#3a3a3e"],["Серый","#6b6b70"],["Фиолетовый","#8a7fa8"],["Жёлтый","#d8c98a"]],
    desc: "Флагман Samsung с пером S Pen, титановым корпусом и камерой 200 Мп. Дисплей 6,8″ QHD+ 120 Гц и чип Snapdragon 8 Gen 3. Galaxy AI на борту."
  },
  {
    id: "s24", brand: "Samsung", style: "samsung", name: "Galaxy S24", gen: "S24", badge: "",
    price: 79990, tone: "#2c3a4a", lenses: 3,
    display: "6,2″ Dynamic AMOLED 2X, FHD+ 120 Гц",
    chip: "Exynos 2400", camera: "50 Мп + 12 Мп + 10 Мп телефото 3×",
    battery: "4000 мА·ч", material: "Алюминий Armor",
    storage: "128 ГБ / 256 ГБ", os: "Android 14 (One UI 6.1)", weight: "167 г",
    connector: "USB-C", water: "IP68", front: "12 Мп",
    colors: "Оникс, кобальт, мрамор, янтарь",
    swatches: [["Оникс","#2a2a2e"],["Кобальт","#2c3a4a"],["Мрамор","#c8c8cc"],["Янтарь","#c7a97e"]],
    desc: "Компактный флагман с Galaxy AI, дисплеем 6,2″ 120 Гц и тройной камерой 50 Мп. Удобный размер и быстрый чип Exynos 2400."
  },
  {
    id: "s23-fe", brand: "Samsung", style: "samsung", name: "Galaxy S23 FE", gen: "S23", badge: "Выгодно",
    price: 54990, tone: "#3a5a52", lenses: 3,
    display: "6,4″ Dynamic AMOLED 2X, FHD+ 120 Гц",
    chip: "Exynos 2200", camera: "50 Мп + 12 Мп + 8 Мп телефото 3×",
    battery: "4500 мА·ч", material: "Алюминий",
    storage: "128 ГБ / 256 ГБ", os: "Android 14 (One UI 6.1)", weight: "209 г",
    connector: "USB-C", water: "IP68", front: "10 Мп",
    colors: "Мятный, графит, фиолетовый, кремовый",
    swatches: [["Мятный","#3a5a52"],["Графит","#3a3a3e"],["Фиолетовый","#8a7fa8"],["Кремовый","#e6ddc8"]],
    desc: "Fan Edition флагмана: дисплей 6,4″ 120 Гц, камера 50 Мп и большой аккумулятор 4500 мА·ч по доступной цене."
  },
  {
    id: "a55", brand: "Samsung", style: "samsung", name: "Galaxy A55", gen: "A", badge: "",
    price: 34990, tone: "#28323e", lenses: 3,
    display: "6,6″ Super AMOLED, FHD+ 120 Гц",
    chip: "Exynos 1480", camera: "50 Мп + 12 Мп + 5 Мп макро",
    battery: "5000 мА·ч", material: "Металл + стекло",
    storage: "128 ГБ / 256 ГБ", os: "Android 14 (One UI 6.1)", weight: "213 г",
    connector: "USB-C", water: "IP67", front: "32 Мп",
    colors: "Тёмно-синий, голубой, лиловый, лимонный",
    swatches: [["Синий","#28323e"],["Голубой","#8aa8c0"],["Лиловый","#b8a8c8"],["Лимонный","#dcd68a"]],
    desc: "Народный середняк: AMOLED 6,6″ 120 Гц, камера 50 Мп с OIS и аккумулятор 5000 мА·ч. Металлический корпус и защита IP67."
  },
  {
    id: "s24-plus", brand: "Samsung", style: "samsung", name: "Galaxy S24+", gen: "S24", badge: "",
    price: 99990, tone: "#3a4658", lenses: 3,
    display: "6,7″ Dynamic AMOLED 2X, QHD+ 120 Гц",
    chip: "Exynos 2400", camera: "50 Мп + 12 Мп + 10 Мп телефото 3×",
    battery: "4900 мА·ч", material: "Алюминий Armor",
    storage: "256 ГБ / 512 ГБ", os: "Android 14 (One UI 6.1)", weight: "196 г",
    connector: "USB-C", water: "IP68", front: "12 Мп",
    colors: "Оникс, кобальт, мрамор, янтарь",
    swatches: [["Оникс","#2a2a2e"],["Кобальт","#3a4658"],["Мрамор","#c8c8cc"],["Янтарь","#c7a97e"]],
    desc: "Большой S24 с дисплеем 6,7″ QHD+ 120 Гц и аккумулятором 4900 мА·ч. Galaxy AI, тройная камера 50 Мп и премиальный корпус."
  },
  {
    id: "s23-ultra", brand: "Samsung", style: "samsung", name: "Galaxy S23 Ultra", gen: "S23", badge: "Хит",
    price: 99990, tone: "#4a4550", lenses: 4,
    display: "6,8″ Dynamic AMOLED 2X, QHD+ 120 Гц",
    chip: "Snapdragon 8 Gen 2", camera: "200 Мп + 12 Мп + 10 Мп + 10 Мп",
    battery: "5000 мА·ч", material: "Алюминий Armor",
    storage: "256 ГБ / 512 ГБ / 1 ТБ", os: "Android 14 (One UI 6.1)", weight: "234 г",
    connector: "USB-C", water: "IP68", front: "12 Мп",
    colors: "Чёрный, зелёный, кремовый, лавандовый",
    swatches: [["Чёрный","#2e2e32"],["Зелёный","#3a4a42"],["Кремовый","#e6ddc8"],["Лавандовый","#b8a8c8"]],
    desc: "Флагман с пером S Pen и камерой 200 Мп. Дисплей 6,8″ QHD+ 120 Гц и чип Snapdragon 8 Gen 2. Проверенный топ по выгодной цене."
  },
  {
    id: "a35", brand: "Samsung", style: "samsung", name: "Galaxy A35", gen: "A", badge: "Выгодно",
    price: 27990, tone: "#2a3a4e", lenses: 3,
    display: "6,6″ Super AMOLED, FHD+ 120 Гц",
    chip: "Exynos 1380", camera: "50 Мп + 8 Мп + 5 Мп макро",
    battery: "5000 мА·ч", material: "Стекло + пластик",
    storage: "128 ГБ / 256 ГБ", os: "Android 14 (One UI 6.1)", weight: "209 г",
    connector: "USB-C", water: "IP67", front: "13 Мп",
    colors: "Тёмно-синий, голубой, лиловый, лимонный",
    swatches: [["Синий","#2a3a4e"],["Голубой","#8aa8c0"],["Лиловый","#b8a8c8"],["Лимонный","#dcd68a"]],
    desc: "Доступный смартфон с AMOLED 6,6″ 120 Гц, камерой 50 Мп и большим аккумулятором 5000 мА·ч. Отличный выбор для повседневных задач."
  },
];

function getPhone(id) { return PHONES.find((p) => p.id === id); }
