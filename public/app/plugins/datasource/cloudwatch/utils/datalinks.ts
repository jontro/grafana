import { DataFrame, FieldType, DataLink, DataQueryRequest, DataQueryResponse, ScopedVars, TimeRange, DataLinkClickEvent } from '@grafana/data';
import { getDataSourceSrv } from '@grafana/runtime';

import { AwsUrl, encodeUrl } from '../aws_url';
import { CloudWatchLogsQuery, CloudWatchQuery } from '../types';

type ReplaceFn = (
  target?: string,
  scopedVars?: ScopedVars,
  displayErrorIfIsMultiTemplateVariable?: boolean,
  fieldName?: string
) => string;

export async function addDataLinksToLogsResponse(
  response: DataQueryResponse,
  request: DataQueryRequest<CloudWatchQuery>,
  replaceFn: ReplaceFn,
  getVariableValueFn: (value: string, scopedVars: ScopedVars) => string[],
  getRegion: (region: string) => string,
  tracingDatasourceUid?: string
): Promise<void> {
  const replace = (target: string, fieldName?: string) => replaceFn(target, request.scopedVars, false, fieldName);
  const getVariableValue = (target: string) => getVariableValueFn(target, request.scopedVars);

  for (const dataFrame of response.data as DataFrame[]) {
    const curTarget = request.targets.find((target) => target.refId === dataFrame.refId) as CloudWatchLogsQuery;
    const interpolatedRegion = getRegion(replace(curTarget.region ?? '', 'region'));

    for (const field of dataFrame.fields) {
      if (field.name === '@xrayTraceId' && tracingDatasourceUid) {
        getRegion(replace(curTarget.region ?? '', 'region'));
        const xrayLink = await createInternalXrayLink(tracingDatasourceUid, interpolatedRegion);
        if (xrayLink) {
          field.config.links = [xrayLink];
        }
      } else if(field.name.endsWith('link')) {
          field.values = field.values.map((item) => {return {toString: () => item};});
          field.config.links = [createDataSetLink()];
      }
    }
    dataFrame.fields.push({
      name: "CloudWatch",
      type: FieldType.string,
      values: Array.from({length: dataFrame.length}, (v, k) => "CloudWatch"),
      config: {
        links: [
          createAwsConsoleLink(curTarget, request.range, interpolatedRegion, replace, getVariableValue)
        ]
      }
    });
  }
}

async function createInternalXrayLink(datasourceUid: string, region: string): Promise<DataLink | undefined> {
  let ds;
  try {
    ds = await getDataSourceSrv().get(datasourceUid);
  } catch (e) {
    console.error('Could not load linked xray data source, it was probably deleted after it was linked', e);
    return undefined;
  }

  return {
    title: ds.name,
    url: '',
    internal: {
      query: { query: '${__value.raw}', queryType: 'getTrace', region: region },
      datasourceUid: datasourceUid,
      datasourceName: ds.name,
    },
  };
}

function createDataSetLink(): DataLink {
  return {
    url: "",
    title: 'View link',
    targetBlank: true,
    onBuildUrl: (event: DataLinkClickEvent<any>) => {
      if (event.replaceVariables) {
        return event.replaceVariables("${__value.raw}")
      }
      return "";
    }
  };
}

function createAwsConsoleLink(
  target: CloudWatchLogsQuery,
  range: TimeRange,
  region: string,
  replace: (target: string, fieldName?: string) => string,
  getVariableValue: (value: string) => string[]
) {
  const arns = (target.logGroups ?? [])
    .filter((group) => group?.arn)
    .map((group) => (group.arn ?? '').replace(/:\*$/, '')); // remove `:*` from end of arn
  const logGroupNames = target.logGroupNames ?? [];
  const sources = arns?.length ? arns : logGroupNames;
  const interpolatedExpression = target.expression ? replace(target.expression) : '';
  const interpolatedGroups = sources?.flatMap(getVariableValue);

  const urlProps: AwsUrl = {
    end: range.to.toISOString(),
    start: range.from.toISOString(),
    timeType: 'ABSOLUTE',
    tz: 'UTC',
    editorString: interpolatedExpression,
    isLiveTail: false,
    source: interpolatedGroups,
  };

  const encodedUrl = encodeUrl(urlProps, region);
  return {
    url: encodedUrl,
    title: 'View in CloudWatch console',
    targetBlank: true,
  };
}
