{
  'includes': [ 'common-sqlite.gypi' ],

  'variables': {
    'sqlite_magic%': '',
  },

  'target_defaults': {
    'default_configuration': 'Release',
    "cflags": [
      '-O3', '-flto', '-pipe', '-ffunction-sections', '-fdata-sections'
    ],
    'cxxflags':[
      '-O3', '-flto', '-pipe', '-ffunction-sections', '-fdata-sections'
    ],
    'ldflags':   [ '-flto', '-Wl,--gc-sections','-s' ],
    'configurations': {
      'Debug': {
        'defines': [ 'DEBUG', '_DEBUG' ],
        'msvs_settings': {
          'VCCLCompilerTool': {
            'RuntimeLibrary': 1, # static debug
          },
        },
      },
      'Release': {
        'defines': [ 'NDEBUG' ],
        'msvs_settings': {
          'VCCLCompilerTool': {
            'RuntimeLibrary': 0, # static release
          },
        },
      }
    },
    'msvs_settings': {
      'VCCLCompilerTool': {
         'Optimization': 2,           # /O2
         'EnableFunctionLevelLinking': 'true', # /Gy
         'EnableIntrinsicFunctions': 'true',
      },
      'VCLibrarianTool': {
      },
      'VCLinkerTool': {
        'EnableCOMDATFolding': '2',  # /OPT:ICF
        'OptimizeReferences': '2',   # /OPT:REF
        'LinkTimeCodeGeneration': 'true', # /LTCG
      },
    },
    'conditions': [
      ['OS == "win"', {
        'defines': [
          'WIN32'
        ],
      }]
    ],
  },

  'targets': [
    {
      'target_name': 'sqlite3',
      'type': 'static_library',
      'include_dirs': [ 'sqlite-amalgamation-<@(sqlite_version)/' ],
      'sources': [
        'sqlite-amalgamation-<@(sqlite_version)/sqlite3.c'
      ],
      'direct_dependent_settings': {
        'include_dirs': [ 'sqlite-amalgamation-<@(sqlite_version)/' ],
        'defines': [
          'SQLITE_THREADSAFE=1',
          'HAVE_USLEEP=1',
          'SQLITE_ENABLE_FTS3',
          'SQLITE_ENABLE_FTS4',
          'SQLITE_ENABLE_FTS5',
          'SQLITE_ENABLE_RTREE',
          'SQLITE_ENABLE_SESSION',
          'SQLITE_ENABLE_JSON',
          'SQLITE_ENABLE_DBSTAT_VTAB=1',
          'SQLITE_ENABLE_MATH_FUNCTIONS'
        ],
      },
      'cflags_cc': [
          '-Wno-unused-value'
      ],
      'defines': [
        '_REENTRANT=1',
        'SQLITE_THREADSAFE=1',
        'HAVE_USLEEP=1',
        'SQLITE_ENABLE_FTS3',
        'SQLITE_ENABLE_FTS4',
        'SQLITE_ENABLE_FTS5',
        'SQLITE_ENABLE_RTREE',
        'SQLITE_ENABLE_SESSION',
        'SQLITE_ENABLE_JSON',
        'SQLITE_ENABLE_DBSTAT_VTAB=1',
        'SQLITE_ENABLE_MATH_FUNCTIONS'
      ],
      'conditions': [
        ["sqlite_magic != ''", {
            'defines': [
              'SQLITE_FILE_HEADER="<(sqlite_magic)"'
            ]
        }]
      ],
    }
  ]
}
