{
  'includes': [ 'common-sqlite.gypi' ],

  'variables': {
    'sqlite_magic%': '',
  },

  'target_defaults': {
    'default_configuration': 'Release',
    "cflags": [
      '-O3', '-flto', '-pipe', '-ffunction-sections', '-fdata-sections', '-fvisibility=hidden'
    ],
    'cxxflags':[
      '-O3', '-flto', '-pipe', '-ffunction-sections', '-fdata-sections', '-fvisibility=hidden'
    ],
    'ldflags':   [ '-flto', '-Wl,--gc-sections', '-s' ],
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
         'FavorSizeOrSpeed': 1,       # /Ot (Favor fast code)
         'StringPooling': 'true',     # /GF
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
          'SQLITE_ENABLE_MATH_FUNCTIONS',
          'SQLITE_ENABLE_STAT4',
          # Deliverable 07: sqlite3_table_column_metadata and the
          # sqlite3_column_{database,table,origin}_name family compile only
          # with this define. Decision recorded in the D07 handoff: the
          # ~30 KB of extra amalgamation code is accepted in exchange for
          # column metadata (stmt.columns) and db.tableInfo().
          'SQLITE_ENABLE_COLUMN_METADATA',
          'SQLITE_DEFAULT_MEMSTATUS=0'
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
        'SQLITE_ENABLE_MATH_FUNCTIONS',
        'SQLITE_ENABLE_STAT4',
        # See the direct_dependent_settings copy above (Deliverable 07).
        'SQLITE_ENABLE_COLUMN_METADATA',
        'SQLITE_DEFAULT_MEMSTATUS=0'
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