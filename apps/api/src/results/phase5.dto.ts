import { ArrayNotEmpty, Equals, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsNumber, IsOptional, Max, Min, ValidateIf } from 'class-validator';

export class SlaPolicyDto {
  @ValidateIf((_object, value: unknown) => value !== undefined) @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(0)
  p95ResponseTimeMs?: number;
  @ValidateIf((_object, value: unknown) => value !== undefined) @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(0) @Max(1)
  maxErrorRate?: number;
}
export class RetentionPolicyDto {
  @IsInt() @Equals(30) retentionDays!: number;
  @IsIn(['manual', 'automatic_after_notice']) deletionMode!: 'manual' | 'automatic_after_notice';
  @IsOptional() @IsInt() @Min(1) @Max(29) noticeDays?: number;
  @IsArray() @ArrayNotEmpty() @IsIn(['in_app', 'email'], { each: true }) channels!: string[];
  @IsOptional() @IsEmail() notificationEmail?: string;
}
export class DeleteProjectDto {
  @IsBoolean() @Equals(true) confirmed!: boolean;
}
