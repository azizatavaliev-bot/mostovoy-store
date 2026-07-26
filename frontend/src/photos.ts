// Фото товаров по id. Внешние URL (файлы не качаем).
// Samsung — Open Icecat (fetch-photos.js). Apple — официальный пресс-кит
// Apple Newsroom (apple.com/newsroom/images/...). Все ссылки проверены
// валидатором server/services/images.js: HTTPS, content-type image/*,
// ширина ≥400px, размер, домен.
//
// Данные лежат в data/photos.json — читается и отсюда, и напрямую
// server/services/seed.js при первичном наполнении каталога.
import photosData from "./data/photos.json";

export const PHOTOS: Record<string, string> = photosData;
