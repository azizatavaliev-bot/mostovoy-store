// Отобранные вручную фото товаров: вырезаны на белом фоне, единые по стилю.
// Фото из базы приходят разношёрстными (тёмные рекламные кадры, коллажи),
// поэтому для известных моделей показываем своё, а базовое остаётся запасным.
// Порядок важен: частные правила идут раньше общих ("17 Pro" перед "17").

export const CURATED_PHOTOS: Array<{ test: RegExp; image: string }> = [
  { test: /iphone 17 pro/i, image: "/images/products/apple/iphone-17-pro.webp" },  // iPhone 17 Pro
  { test: /iphone 17(?! pro)/i, image: "/images/products/apple/iphone-17.webp" },  // iPhone 17
  { test: /iphone air/i, image: "/images/products/apple/iphone-air.webp" },  // iPhone Air
  { test: /iphone 16 pro/i, image: "/images/products/apple/iphone-16-pro.webp" },  // iPhone 16 Pro
  { test: /iphone 16(?! pro| plus)|iphone 16 plus/i, image: "/images/products/apple/iphone-16.webp" },  // iPhone 16
  { test: /iphone 16e/i, image: "/images/products/apple/iphone-16e.webp" },  // iPhone 16e
  { test: /iphone 15/i, image: "/images/products/apple/iphone-15.webp" },  // iPhone 15
  { test: /iphone (14|13|se)/i, image: "/images/products/apple/iphone-14.webp" },  // Прошлые поколения
  { test: /ipad pro 13/i, image: "/images/products/apple/ipad-pro-13.webp" },  // iPad Pro 13"
  { test: /ipad pro 11/i, image: "/images/products/apple/ipad-pro-11.webp" },  // iPad Pro 11"
  { test: /ipad air 13/i, image: "/images/products/apple/ipad-air-13.webp" },  // iPad Air 13"
  { test: /ipad air (7|8)?\s*m\d 11|ipad air 11/i, image: "/images/products/apple/ipad-air-11.webp" },  // iPad Air 11"
  { test: /^ipad 11/i, image: "/images/products/apple/ipad-11.webp" },  // iPad
  { test: /neo/i, image: "/images/products/apple/macbook-neo.webp" },  // MacBook Neo
  { test: /air 13/i, image: "/images/products/apple/macbook-air-13.webp" },  // MacBook Air 13"
  { test: /air 15/i, image: "/images/products/apple/macbook-air-15.webp" },  // MacBook Air 15"
  { test: /pro 14/i, image: "/images/products/apple/macbook-pro-14.webp" },  // MacBook Pro 14"
  { test: /pro 16/i, image: "/images/products/apple/macbook-pro-16.webp" },  // MacBook Pro 16"
  { test: /series 11/i, image: "/images/products/apple/watch-series-11.webp" },  // Apple Watch Series 11
  { test: /ultra 3/i, image: "/images/products/apple/watch-ultra-3.webp" },  // Apple Watch Ultra 3
  { test: /se 3/i, image: "/images/products/apple/watch-se-3.webp" },  // Apple Watch SE 3
  { test: /pro 3/i, image: "/images/products/apple/airpods-pro-3.webp" },  // AirPods Pro 3
  { test: /airpods 4/i, image: "/images/products/apple/airpods-4.webp" },  // AirPods 4
  { test: /airpods max/i, image: "/images/products/apple/airpods-max.webp" },  // AirPods Max
  { test: /beats/i, image: "/images/products/other/beats-studio-pro.webp" },  // Beats
  { test: /s25 ultra/i, image: "/images/products/samsung/galaxy-s25-ultra.webp" },  // Galaxy S25 Ultra
  { test: /s25(?! ultra)/i, image: "/images/products/samsung/galaxy-s25.webp" },  // Galaxy S25
  { test: /s24|s23/i, image: "/images/products/samsung/galaxy-s24-ultra.webp" },  // Galaxy S24
  { test: /galaxy a/i, image: "/images/products/samsung/galaxy-a55.webp" },  // Galaxy A
  { test: /ray-ban|wayfarer/i, image: "/images/products/meta/rayban-wayfarer.webp" },  // Ray-Ban Meta
  { test: /oakley/i, image: "/images/products/meta/oakley-vanguard.webp" },  // Oakley Meta
  { test: /quest/i, image: "/images/products/meta/quest-3.webp" },  // Meta Quest
  { test: /fenix/i, image: "/images/products/garmin/fenix-8.webp" },  // Garmin Fenix 8
  { test: /forerunner/i, image: "/images/products/garmin/forerunner-970.webp" },  // Garmin Forerunner
  { test: /venu|lily/i, image: "/images/products/garmin/venu-4.webp" },  // Garmin Venu
  { test: /marq|tactix|quatix/i, image: "/images/products/garmin/marq-adventurer.webp" },  // Garmin MARQ
  { test: /whoop/i, image: "/images/products/other/whoop-5.webp" },  // Whoop 5.0
  { test: /(станция|station).*(дуо|duo)/i, image: "/images/products/other/yandex-station-max-duo.webp" },
  { test: /(станция|station).*(лайт|lite)/i, image: "/images/products/other/yandex-station-lite-2.webp" },
  { test: /(станция|station).*(мини|mini).*(pro|про)/i, image: "/images/products/other/yandex-station-mini-3-pro.webp" },
  { test: /(станция|station).*(мини|mini)/i, image: "/images/products/other/yandex-station-mini-3.webp" },
  { test: /(станция|station).*(миди|midi)/i, image: "/images/products/other/yandex-station-midi.webp" },
  { test: /(станция|station).*(макс|max)/i, image: "/images/products/other/yandex-station-max.webp" },
  { test: /(станция|station) 3/i, image: "/images/products/other/yandex-station-3.webp" },
  { test: /станция|yandex station/i, image: "/images/products/other/yandex-station-max.webp" },  // Яндекс Станция
  { test: /dji mic/i, image: "/images/products/other/dji-mic-3.webp" },  // DJI Mic
  { test: /playstation|switch|steam deck/i, image: "/images/products/other/ps5-pro.webp" },  // Игровые приставки
  { test: /canon|instax/i, image: "/images/products/other/canon-g7x.webp" },  // Камеры
  { test: /oneblade|styleshaver/i, image: "/images/products/other/philips-oneblade.webp" },  // Philips-бритвы (раньше перед общим правилом ниже)
  { test: /dyson|philips|airwrap|airstrait/i, image: "/images/products/dyson/airwrap.webp" },  // Красота
  { test: /kindle/i, image: "/images/products/other/kindle-paperwhite.webp" },  // Электронные книги
  { test: /pencil|keyboard|mouse|расч/i, image: "/images/products/apple/apple-pencil-pro.webp" },  // Аксессуары

  // ——— Добавлено: модели, у которых фото в каталоге не было ———
  // Порядок внутри блока важен: частные правила раньше общих.

  // Samsung. «Galaxy Watch Ultra» должен сработать раньше Apple Watch Ultra.
  { test: /galaxy watch ultra/i, image: "/images/products/samsung/galaxy-watch-ultra.webp" },
  { test: /watch ?6 classic/i, image: "/images/products/samsung/galaxy-watch6-classic.webp" },
  { test: /fold ?8/i, image: "/images/products/samsung/galaxy-z-fold-8.webp" },  // Galaxy Z Fold 8 (раньше Fold 6/5, чтобы не перехватывались)
  { test: /z fold ?6/i, image: "/images/products/samsung/galaxy-z-fold-6.webp" },
  { test: /z fold ?5/i, image: "/images/products/samsung/galaxy-z-fold-5.webp" },
  { test: /z flip ?6/i, image: "/images/products/samsung/galaxy-z-flip-6.webp" },
  { test: /z flip ?5/i, image: "/images/products/samsung/galaxy-z-flip-5.webp" },
  { test: /s26 ultra/i, image: "/images/products/samsung/galaxy-s26-ultra.webp" },
  { test: /s26/i, image: "/images/products/samsung/galaxy-s26.webp" },
  { test: /tab s9/i, image: "/images/products/samsung/galaxy-tab-s9-plus.webp" },
  { test: /tab a9/i, image: "/images/products/samsung/galaxy-tab-a9.webp" },
  { test: /buds ?3/i, image: "/images/products/samsung/galaxy-buds-3.webp" },
  { test: /buds ?2 pro/i, image: "/images/products/samsung/galaxy-buds2-pro.webp" },

  // Apple Watch прошлых поколений (Series 11, SE 3 и Ultra 3 разобраны выше).
  { test: /watch ultra/i, image: "/images/products/apple/watch-ultra-2.webp" },
  { test: /series 10/i, image: "/images/products/apple/watch-series-10.webp" },
  { test: /series 9/i, image: "/images/products/apple/watch-series-9.webp" },
  { test: /watch se/i, image: "/images/products/apple/watch-se-2.webp" },

  // iPad прошлых поколений.
  { test: /ipad mini/i, image: "/images/products/apple/ipad-mini.webp" },
  { test: /ipad pro 12\.9/i, image: "/images/products/apple/ipad-pro-12-9-m2.webp" },
  { test: /ipad air 5|ipad air 5 /i, image: "/images/products/apple/ipad-air-5.webp" },
  { test: /ipad air 6/i, image: "/images/products/apple/ipad-air-6.webp" },
  { test: /ipad air (7|8)/i, image: "/images/products/apple/ipad-air-11.webp" },
  { test: /ipad 9/i, image: "/images/products/apple/ipad-9.webp" },
  { test: /ipad 10/i, image: "/images/products/apple/ipad-10.webp" },
  { test: /ipad 11/i, image: "/images/products/apple/ipad-11.webp" },

  // iPhone и наушники прошлых поколений.
  { test: /iphone 12 pro/i, image: "/images/products/apple/iphone-12-pro.webp" },
  { test: /iphone 12/i, image: "/images/products/apple/iphone-12.webp" },
  { test: /iphone 11/i, image: "/images/products/apple/iphone-11.webp" },
  { test: /airpods pro 2/i, image: "/images/products/apple/airpods-pro-2.webp" },
  { test: /airpods 3/i, image: "/images/products/apple/airpods-3.webp" },
  { test: /airpods 2/i, image: "/images/products/apple/airpods-2.webp" },
  { test: /macbook pro 13|pro 13\.3/i, image: "/images/products/apple/macbook-pro-13-m2.webp" },
  { test: /macbook pro m[34]/i, image: "/images/products/apple/macbook-pro-14.webp" },

  // Garmin.
  { test: /epix/i, image: "/images/products/garmin/garmin-epix-pro.webp" },
  { test: /instinct/i, image: "/images/products/garmin/garmin-instinct-3-amoled.webp" },

  // Redmi Note: раньше остальных Xiaomi, иначе «Note 13 Pro» перехватит правило «13 Pro».
  { test: /note 14 pro\s*(\+|plus)/i, image: "/images/products/xiaomi/redmi-note-14-pro-plus.webp" },
  { test: /note 14 pro/i, image: "/images/products/xiaomi/redmi-note-14-pro.webp" },
  { test: /note 14/i, image: "/images/products/xiaomi/redmi-note-14.webp" },
  { test: /note 13 pro\s*(\+|plus)/i, image: "/images/products/xiaomi/redmi-note-13-pro-plus.webp" },
  { test: /note 13 pro/i, image: "/images/products/xiaomi/redmi-note-13-pro.webp" },
  { test: /note 13/i, image: "/images/products/xiaomi/redmi-note-13.webp" },

  // POCO.
  { test: /poco x7 pro/i, image: "/images/products/xiaomi/poco-x7-pro.webp" },
  { test: /poco x7/i, image: "/images/products/xiaomi/poco-x7.webp" },
  { test: /poco f5 pro/i, image: "/images/products/xiaomi/poco-f5-pro.webp" },
  { test: /poco f7/i, image: "/images/products/xiaomi/poco-f7.webp" },
  { test: /poco m5s/i, image: "/images/products/xiaomi/poco-m5s.webp" },
  { test: /poco c75/i, image: "/images/products/xiaomi/poco-c75.webp" },
  { test: /poco x6 pro/i, image: "/images/products/xiaomi/poco-x6-pro.webp" },
  { test: /poco x5 pro/i, image: "/images/products/xiaomi/poco-x5-pro.webp" },
  { test: /poco m7 pro/i, image: "/images/products/xiaomi/poco-m7-pro.webp" },
  { test: /poco m6 pro/i, image: "/images/products/xiaomi/poco-m6-pro.webp" },
  { test: /poco m6/i, image: "/images/products/xiaomi/poco-m6.webp" },
  { test: /poco m5(?!s)/i, image: "/images/products/xiaomi/poco-m5.webp" },
  { test: /poco c65/i, image: "/images/products/xiaomi/poco-c65.webp" },

  // Планшеты Xiaomi.
  { test: /pad se 8\\.7/i, image: "/images/products/xiaomi/xiaomi-pad-se-8-7.webp" },
  { test: /redmi pad 2/i, image: "/images/products/xiaomi/redmi-pad-2.webp" },
  { test: /pad 7/i, image: "/images/products/xiaomi/xiaomi-mi-pad-7.webp" },
  { test: /pad se/i, image: "/images/products/xiaomi/xiaomi-pad-se.webp" },
  { test: /pad 6/i, image: "/images/products/xiaomi/xiaomi-pad-6.webp" },

  // Смартфоны Xiaomi и Redmi.
  { test: /14t pro/i, image: "/images/products/xiaomi/xiaomi-14t-pro.webp" },
  { test: /14t/i, image: "/images/products/xiaomi/xiaomi-14t.webp" },
  { test: /13t/i, image: "/images/products/xiaomi/xiaomi-13t.webp" },
  { test: /12t pro/i, image: "/images/products/xiaomi/xiaomi-12t-pro.webp" },
  { test: /12t/i, image: "/images/products/xiaomi/xiaomi-12t.webp" },
  { test: /xiaomi 13 pro|\bmi 13 pro/i, image: "/images/products/xiaomi/xiaomi-13-pro.webp" },
  { test: /xiaomi 13|\bmi 13/i, image: "/images/products/xiaomi/xiaomi-13.webp" },
  { test: /xiaomi 12 lite|\bmi 12 lite/i, image: "/images/products/xiaomi/xiaomi-12-lite.webp" },
  { test: /xiaomi 12|\bmi 12/i, image: "/images/products/xiaomi/xiaomi-12.webp" },
  { test: /redmi 14c/i, image: "/images/products/xiaomi/redmi-14c.webp" },
  { test: /redmi 13c/i, image: "/images/products/xiaomi/redmi-13c.webp" },
  { test: /redmi 12/i, image: "/images/products/xiaomi/redmi-12.webp" },
  { test: /redmi a3/i, image: "/images/products/xiaomi/redmi-a3.webp" },

  // Прочее.
  { test: /insta360/i, image: "/images/products/other/insta360-x3.webp" },
  { test: /plaud/i, image: "/images/products/other/plaud-note.webp" },

  // Meta Starfire, Omega, DJI — частные правила раньше общих (osmo mobile / osmo nano / pocket 3).
  { test: /starfire/i, image: "/images/products/meta/meta-starfire.webp" },  // Meta Starfire (Kylie Edition)
  { test: /seamaster/i, image: "/images/products/other/omega-seamaster.webp" },  // Omega Seamaster
  { test: /osmo mobile/i, image: "/images/products/other/dji-osmo-mobile-8p.webp" },  // DJI Osmo Mobile 8P
  { test: /osmo nano/i, image: "/images/products/other/dji-osmo-nano.webp" },  // DJI Osmo Nano
  { test: /pocket ?3/i, image: "/images/products/other/dji-pocket-3.webp" },  // DJI Pocket 3
]

/** Путь к отобранному фото для товара — или пустая строка, если его нет. */
export function curatedPhoto(name: string): string {
  const value = String(name || "")
  return CURATED_PHOTOS.find((row) => row.test.test(value))?.image || ""
}
