// The people of the demo: three accounts to sign in with and a crowd generated from fixed lists.

/** Accounts documented in docs/local-run.md; they sign in by magic link through Mailpit. */
export const DEMO_ACCOUNTS = {
  user: 'demo-user@example.test',
  newcomer: 'demo-newcomer@example.test',
  admin: 'demo-admin@example.test',
};

const STACK_BY_ROLE = {
  pm: ['figma', 'sql', 'uml_bpmn'],
  frontend: ['typescript', 'react', 'nextjs', 'javascript', 'vue', 'playwright'],
  backend: ['nodejs', 'nestjs', 'postgresql', 'python', 'fastapi', 'go', 'redis', 'docker'],
  mobile: ['kotlin', 'swift', 'flutter', 'react_native'],
  ba: ['uml_bpmn', 'sql', 'openapi'],
  product_analyst: ['sql', 'python', 'pandas'],
  system_analyst: ['openapi', 'uml_bpmn', 'sql', 'kafka'],
  designer: ['figma'],
  ml_engineer: ['python', 'pytorch', 'scikit_learn', 'pandas', 'fastapi'],
  data_engineer: ['python', 'airflow', 'spark', 'sql', 'postgresql', 'kafka'],
  qa: ['playwright', 'selenium', 'sql', 'typescript'],
  devops: ['docker', 'kubernetes', 'ci_cd', 'linux'],
};

const STRENGTHS = {
  pm: ['Держу сроки и договорённости', 'Умею резать объём под appetite', 'Спокойно веду созвоны'],
  frontend: ['Аккуратная вёрстка', 'Доступность интерфейсов', 'Пишу e2e-тесты на формы'],
  backend: ['Проектирую API заранее', 'Пишу миграции без простоя', 'Люблю разбирать логи'],
  mobile: ['Довожу экраны до стора', 'Офлайн-режим и кеш', 'Анимации без лагов'],
  ba: ['Пишу понятные истории', 'Нахожу противоречия в требованиях', 'Рисую BPMN'],
  product_analyst: ['Провожу интервью', 'Считаю воронки в SQL', 'Формулирую гипотезы'],
  system_analyst: ['Описываю интеграции', 'Пишу OpenAPI-контракты', 'Разбираю краевые случаи'],
  designer: ['Быстрые прототипы в Figma', 'Юзабилити-тесты', 'Собираю UI-кит'],
  ml_engineer: ['Честная валидация моделей', 'Быстрые бейзлайны', 'Разбор ошибок модели'],
  data_engineer: ['Надёжные пайплайны', 'Чистка грязных данных', 'Версионирую датасеты'],
  qa: ['Регресс по чек-листу', 'Нахожу баги на стыках', 'Автотесты на Playwright'],
  devops: ['CI за вечер', 'Мониторинг и алерты', 'План отката до релиза'],
};

const WEAKNESSES = [
  'Пока мало опыта в больших командах',
  'Иногда долго полирую детали',
  'Учусь оценивать задачи',
  'Не люблю длинные созвоны',
  'Мало опыта с продом',
  'Только начинаю писать тесты',
];

const EXPERIENCE = {
  pm: ['Координатор студенческого хакатона', 'Помощник менеджера проектов в веб-студии'],
  frontend: ['Стажёр frontend в финтех-стартапе', 'Пет-проект: трекер расходов на React'],
  backend: ['Стажёр backend в логистической компании', 'Бот для записи в барбершоп на Node.js'],
  mobile: ['Курс Android-разработки, дипломное приложение', 'Приложение для учёта тренировок'],
  ba: ['Аналитик-стажёр во внутренней ИТ-службе банка', 'Описание процессов для склада'],
  product_analyst: ['Исследование аудитории онлайн-школы', 'Дашборды продаж для кофейни'],
  system_analyst: ['Интеграция CRM с телефонией', 'Спецификации для госуслуг региона'],
  designer: ['Редизайн сайта городской библиотеки', 'Фриланс: лендинги для малого бизнеса'],
  ml_engineer: ['Курсовая: классификация отзывов', 'Kaggle: прогноз оттока клиентов'],
  data_engineer: [
    'ETL для отчётности интернет-магазина',
    'Стажёр в отделе данных телеком-оператора',
  ],
  qa: ['Тестировщик-стажёр в продуктовой компании', 'Краудтестинг мобильных приложений'],
  devops: ['Админ серверов студенческого клуба', 'CI/CD для пет-проектов друзей'],
};

const TIMEZONES = [
  'Europe/Moscow',
  'Europe/Moscow',
  'Europe/Moscow',
  'Europe/Moscow',
  'Asia/Yekaterinburg',
  'Europe/Samara',
  'Asia/Novosibirsk',
  'Europe/Kaliningrad',
  'Europe/Minsk',
  'Asia/Almaty',
];

// [first name, last name, primary role, second role or null]. Order matters: ids and logins follow it.
const CROWD = [
  ['Дмитрий', 'Орлов', 'frontend', null],
  ['Мария', 'Ковалёва', 'designer', 'frontend'],
  ['Алексей', 'Морозов', 'backend', 'devops'],
  ['Екатерина', 'Волкова', 'pm', 'ba'],
  ['Никита', 'Лебедев', 'backend', null],
  ['Полина', 'Соколова', 'product_analyst', 'ba'],
  ['Артём', 'Новиков', 'frontend', 'qa'],
  ['Дарья', 'Фёдорова', 'qa', null],
  ['Иван', 'Козлов', 'devops', 'backend'],
  ['София', 'Павлова', 'designer', null],
  ['Максим', 'Семёнов', 'ml_engineer', 'data_engineer'],
  ['Алина', 'Голубева', 'ba', 'system_analyst'],
  ['Егор', 'Виноградов', 'mobile', 'frontend'],
  ['Виктория', 'Богданова', 'system_analyst', 'ba'],
  ['Кирилл', 'Воробьёв', 'frontend', null],
  ['Анастасия', 'Медведева', 'product_analyst', null],
  ['Роман', 'Зайцев', 'backend', null],
  ['Ксения', 'Сорокина', 'pm', null],
  ['Тимур', 'Галиев', 'data_engineer', 'backend'],
  ['Ева', 'Белова', 'ml_engineer', null],
  ['Георгий', 'Тарасов', 'qa', 'frontend'],
  ['Ульяна', 'Комарова', 'designer', 'product_analyst'],
  ['Михаил', 'Киселёв', 'devops', null],
  ['Вероника', 'Макарова', 'frontend', 'designer'],
  ['Илья', 'Андреев', 'backend', 'system_analyst'],
  ['Арина', 'Ильина', 'ba', null],
  ['Матвей', 'Гусев', 'mobile', null],
  ['Валерия', 'Титова', 'pm', 'product_analyst'],
  ['Владислав', 'Кузьмин', 'ml_engineer', 'backend'],
  ['Елизавета', 'Кудрявцева', 'qa', null],
  ['Денис', 'Баранов', 'frontend', null],
  ['Александра', 'Куликова', 'product_analyst', 'pm'],
  ['Павел', 'Алексеев', 'data_engineer', null],
  ['Яна', 'Степанова', 'designer', null],
  ['Олег', 'Яковлев', 'backend', null],
  ['Камила', 'Сафина', 'system_analyst', null],
  ['Сергей', 'Никитин', 'devops', 'qa'],
  ['Милана', 'Захарова', 'frontend', null],
  ['Лев', 'Романов', 'ml_engineer', null],
  ['Диана', 'Борисова', 'ba', 'product_analyst'],
  ['Глеб', 'Королёв', 'backend', 'frontend'],
  ['Таисия', 'Герасимова', 'pm', null],
  ['Фёдор', 'Пономарёв', 'qa', null],
  ['Василиса', 'Григорьева', 'designer', 'frontend'],
  ['Руслан', 'Хабибуллин', 'mobile', 'backend'],
  ['Олеся', 'Лазарева', 'data_engineer', 'ml_engineer'],
  ['Степан', 'Медведев', 'frontend', null],
  ['Злата', 'Ершова', 'product_analyst', null],
  ['Даниил', 'Никифоров', 'backend', null],
  ['Нелли', 'Ахмедова', 'qa', 'ba'],
  ['Ярослав', 'Мельников', 'devops', null],
  ['Лидия', 'Чернова', 'ml_engineer', 'product_analyst'],
  ['Борис', 'Абрамов', 'system_analyst', 'backend'],
  ['Карина', 'Власова', 'frontend', null],
  ['Антон', 'Блинов', 'backend', 'ml_engineer'],
];

const LEVELS = ['beginner', 'junior', 'junior', 'middle'];

const TRANSLIT = Object.fromEntries([
  ...'абвгдезийклмнопрстуфхцы'.split('').map((c, i) => [c, 'abvgdeziyklmnoprstufhcy'[i]]),
  ['ё', 'e'],
  ['ж', 'zh'],
  ['ч', 'ch'],
  ['ш', 'sh'],
  ['щ', 'sch'],
  ['ъ', ''],
  ['ь', ''],
  ['э', 'e'],
  ['ю', 'yu'],
  ['я', 'ya'],
]);
const translit = (text) => [...text.toLowerCase()].map((c) => TRANSLIT[c] ?? c).join('');

function crowdPerson([first, last, role, second], i) {
  const login = `${translit(first)}-${translit(last)}`;
  const roles = [[role, LEVELS[i % LEVELS.length]]];
  if (second) roles.push([second, i % 3 === 0 ? 'beginner' : 'junior']);
  const stack = [...new Set(roles.flatMap(([r]) => STACK_BY_ROLE[r].slice(0, 2 + (i % 3))))];
  return {
    key: login,
    name: `${first} ${last}`,
    email: `${login}@example.test`,
    githubLogin: i % 4 === 3 ? null : `${login}-dev`,
    roles,
    stack,
    timezone: TIMEZONES[i % TIMEZONES.length],
    hours: [6, 8, 10, 12, 15, 20, 25][i % 7],
    createdDaysAgo: 30 + ((i * 37) % 150),
    strengths: STRENGTHS[role].slice(0, 2 + (i % 2)),
    weaknesses: [WEAKNESSES[i % WEAKNESSES.length]],
    experience: [
      {
        title: EXPERIENCE[role][i % 2],
        from: `202${3 + (i % 3)}-0${1 + (i % 9)}-01`,
        to: i % 3 ? '2026-06-30' : null,
      },
    ],
    portfolio: i % 3 === 0 ? `https://github.com/${login}-dev` : null,
  };
}

const DEMO_PEOPLE = [
  {
    key: 'demo-user',
    name: 'Анна Смирнова',
    email: DEMO_ACCOUNTS.user,
    githubLogin: 'anna-smirnova-demo',
    roles: [
      ['pm', 'middle'],
      ['product_analyst', 'junior'],
    ],
    stack: ['figma', 'sql', 'uml_bpmn', 'python'],
    timezone: 'Europe/Moscow',
    hours: 15,
    createdDaysAgo: 170,
    strengths: [
      'Собираю команду вокруг понятной цели',
      'Пишу короткие и ясные PR/FAQ',
      'Держу ритм созвонов',
    ],
    weaknesses: ['Иногда беру на себя слишком много'],
    experience: [
      {
        title: 'Менеджер проектов в ИТ-аутсорсе',
        description: 'Вела 3 проекта для ритейла, команды по 4-6 человек.',
        from: '2024-03-01',
        to: null,
      },
      {
        title: 'Аналитик в службе доставки',
        description: 'Считала воронку заказов и проводила интервью с курьерами.',
        from: '2022-09-01',
        to: '2024-02-28',
      },
    ],
    portfolio: 'https://github.com/anna-smirnova-demo',
  },
  {
    key: 'demo-newcomer',
    name: 'Игорь Ветров',
    email: DEMO_ACCOUNTS.newcomer,
    githubLogin: 'igor-vetrov-demo',
    roles: [
      ['frontend', 'beginner'],
      ['qa', 'beginner'],
    ],
    stack: ['javascript', 'typescript', 'react'],
    timezone: 'Asia/Yekaterinburg',
    hours: 10,
    createdDaysAgo: 12,
    strengths: ['Быстро учусь', 'Внимателен к деталям интерфейса'],
    weaknesses: ['Это мой первый командный проект'],
    experience: [
      {
        title: 'Курс «Frontend с нуля»',
        description: 'Дипломный проект: каталог фильмов на React.',
        from: '2026-03-01',
        to: '2026-08-31',
      },
    ],
    portfolio: null,
  },
  {
    key: 'demo-admin',
    name: 'Ольга Админова',
    email: DEMO_ACCOUNTS.admin,
    githubLogin: null,
    roles: [['pm', 'middle']],
    stack: ['sql'],
    timezone: 'Europe/Moscow',
    hours: 5,
    createdDaysAgo: 200,
    strengths: ['Модерация и разбор спорных случаев'],
    weaknesses: [],
    experience: [],
    portfolio: null,
    isAdmin: true,
  },
];

export const PEOPLE = [...DEMO_PEOPLE, ...CROWD.map(crowdPerson)];
