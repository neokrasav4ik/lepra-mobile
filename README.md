# Lepra Mobile

Пользовательский скрипт, который делает [leprosorium.ru](https://leprosorium.ru) пригодным для чтения с телефона.

## Установка (iOS Safari)

1. Поставьте из App Store приложение **Userscripts** (автор Justin Wasack, бесплатное, открытый код).
2. Откройте приложение и выберите папку для скриптов.
3. Настройки → Приложения → Safari → Расширения → Userscripts → включить. Там же для `leprosorium.ru` поставьте «Всегда разрешать».
4. Положите `lepra-mobile.user.js` в выбранную для скриптов папку. Имя обязательно должно оканчиваться на `.user.js`.
5. Откройте Лепру, тапните левый значок в адресной строке → Userscripts → в списке должен появиться Lepra Mobile.

## Установка (Android Firefox)

1. В Firefox откройте меню (три точки) → Extensions (Расширения) → найдите **Tampermonkey** → Add.    
2. Firefox → меню (три точки) → Расширения → Tampermonkey → Панель управления (Dashboard) → Вкладка Утилиты (Utilities).
3. Поле Установить с URL (Install from URL) — вставьте туда:
```
https://raw.githubusercontent.com/neokrasav4ik/lepra-mobile/main/lepra-mobile.user.js
```
4. Нажмите Установить. Откроется страница подтверждения со списком того, что скрипт запрашивает, — там же будет кнопка установки.
