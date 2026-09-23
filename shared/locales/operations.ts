import type { MessageCatalog } from '../i18n-types.js'
export const operationMessages: MessageCatalog = {
 'common.fileNameBytes': {ru:'Имя занимает больше {count} байт UTF-8. Сократите его.',en:'The name exceeds {count} UTF-8 bytes. Shorten it.'},
 'runtime.brokerUnavailable': {ru:'На этой установке исполнитель соревнований не подключён. Обратитесь к администратору.',en:'The competition executor is not configured on this installation. Contact the administrator.'},
 'runtime.dockerUnavailable': {ru:'Исполнитель временно недоступен. Проверьте Docker и повторите попытку.',en:'The executor is temporarily unavailable. Check Docker and try again.'},
 'runtime.imageUnavailable': {ru:'Закреплённый образ окружения недоступен. Преподавателю нужно восстановить или собрать окружение.',en:'The pinned environment image is unavailable. The teacher needs to restore or build it.'},
 'runtime.preparationVersion': {ru:'Для безопасной подготовки пакетов требуется Docker Engine 28 или новее.',en:'Safe package preparation requires Docker Engine 28 or newer.'},
 'runtime.storageUnavailable': {ru:'Хранилище исполнителя недоступно. Обратитесь к администратору.',en:'The executor storage is unavailable. Contact the administrator.'},
 'runtime.prepareUnavailable': {ru:'Подготовка пакетов недоступна.',en:'Package preparation is unavailable.'},
}
